// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";
import {ComplianceHub} from "../src/ComplianceHub.sol";
import {VaultKernel} from "../src/VaultKernel.sol";
import {PayeeCodecEvm} from "../src/payees/PayeeCodecEvm.sol";
import {PoseidonHasher2} from "../src/hashers/PoseidonHasher2.sol";
import {Erc20AssetAdapter} from "../src/adapters/Erc20AssetAdapter.sol";
import {Erc20SettlementAdapter} from "../src/adapters/Erc20SettlementAdapter.sol";
import {UniswapV3SettlementAdapter} from "../src/adapters/UniswapV3SettlementAdapter.sol";
import {SimpleErc20} from "../src/tokens/SimpleErc20.sol";
import {IAssetAdapter} from "../src/interfaces/IAssetAdapter.sol";
import {ISettlementAdapter} from "../src/interfaces/ISettlementAdapter.sol";
import {ActionRouterDeploy} from "./ActionRouterDeploy.sol";

/// @notice Greenfield vault stack deploy (D1 multi-token + optional Uniswap V3 settlement).
///
/// Env (required):
///   GOVERNANCE_ADDRESS, POSTMAN_ADDRESS
///
/// Env (optional):
///   ASSET_TOKEN / SETTLEMENT_DST_TOKEN — ERC-20s (deploy SimpleErc20 if unset)
///   SWAP_ROUTER — if set, deploy UniswapV3SettlementAdapter; else bootstrap Erc20SettlementAdapter
///   SETTLEMENT_LIQUIDITY_WEI — fund bootstrap adapter dst inventory
///   REGISTRY_MIN_DELAY, ADMIT_EPOCH_SECONDS, REGISTER_VERIFIER, PAUSE_DEPOSITS_ON_DEPLOY
contract DeployVaultStack is Script {
    uint256 internal constant DEFAULT_ADMIT_EPOCH = 300;

    struct Deployment {
        address governance;
        address postman;
        address registry;
        address hub;
        address payees;
        address hasher;
        address assets;
        address settlement;
        address assetToken;
        address dstToken;
        address swapRouter;
        address vault;
        address router;
        uint256 deployBlock;
    }

    /// @dev Canonical poseidon-solidity deployments. Keep in sync with the `libraries` pins in
    /// foundry.toml — solc links those addresses at compile time, these only verify them at run
    /// time. Seed a local chain with `make anvil-poseidon`.
    address internal constant POSEIDON_T3 = 0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93;
    address internal constant POSEIDON_T4 = 0x4443338EF595F44e0121df4C21102677B142ECF0;

    function _requirePoseidon(address lib, string memory name) internal view {
        if (lib.code.length != 0) return;
        console2.log("Missing linked library", name);
        console2.log("Expected at", lib);
        revert(
            "Linked poseidon library has no code on this chain. A delegatecall to an empty "
            "address returns silently, so this would corrupt every hash. On a local chain run "
            "`make anvil-poseidon` to seed the canonical bytecode."
        );
    }

    function run() external returns (Deployment memory d) {
        d.governance = vm.envAddress("GOVERNANCE_ADDRESS");
        d.postman = vm.envAddress("POSTMAN_ADDRESS");
        uint256 minDelay = vm.envOr("REGISTRY_MIN_DELAY", uint256(0));
        uint256 admitEpoch = vm.envOr("ADMIT_EPOCH_SECONDS", DEFAULT_ADMIT_EPOCH);
        bool registerVerifier = vm.envOr("REGISTER_VERIFIER", true);
        bool pauseDeposits = vm.envOr("PAUSE_DEPOSITS_ON_DEPLOY", false);
        uint256 settlementLiq = vm.envOr("SETTLEMENT_LIQUIDITY_WEI", uint256(0));
        d.swapRouter = vm.envOr("SWAP_ROUTER", address(0));

        vm.startBroadcast();

        // ── Preflight ────────────────────────────────────────────────────────────────────
        // Both checks run before a single contract is deployed. forge simulates the whole
        // script before broadcasting anything, so reverting here costs no gas and, crucially,
        // writes no deployment record.

        // Everything below that configures the vault is gated on `msg.sender == d.governance`,
        // and `governance` is immutable. Getting this wrong used to skip setTokenAllowed and
        // approveAssetOutbound with no else branch and no log: a clean-looking deploy whose
        // every deposit reverts and which can only be fixed by redeploying. A Safe cannot
        // broadcast a forge script, so this fires whenever GOVERNANCE_ADDRESS is a multisig.
        if (msg.sender != d.governance && !vm.envOr("ALLOW_UNCONFIGURED_GOVERNANCE", false)) {
            console2.log("Broadcaster", msg.sender);
            console2.log("GOVERNANCE_ADDRESS", d.governance);
            revert(
                "Broadcaster != GOVERNANCE_ADDRESS: setTokenAllowed/approveAssetOutbound would be "
                "skipped and governance is immutable. Deploy from the governance EOA, or set "
                "ALLOW_UNCONFIGURED_GOVERNANCE=true and finish the setup via BootstrapVault."
            );
        }

        // poseidon-solidity exposes `public` functions, so it is delegatecalled as a linked
        // library. A DELEGATECALL to an address with no code SUCCEEDS and returns nothing, so a
        // missing library silently corrupts every hash instead of reverting. Our own via_ir build
        // is over EIP-170 (T3 29315, T4 32895 > 24576) and cannot be deployed, so foundry.toml
        // links the canonical deployments — present on Sepolia and Base, absent on a fresh anvil.
        _requirePoseidon(POSEIDON_T3, "PoseidonT3");
        _requirePoseidon(POSEIDON_T4, "PoseidonT4");

        ActionRouterDeploy.VerifierBundle memory verifiers = ActionRouterDeploy.deployVerifiers();
        d.router = address(ActionRouterDeploy.deployRouterFrom(verifiers));

        d.registry = address(new VerifierRegistry(d.governance, minDelay));
        d.hub = address(new ComplianceHub(d.postman, admitEpoch));
        d.payees = address(new PayeeCodecEvm());
        d.hasher = address(new PoseidonHasher2());

        d.assetToken = vm.envOr("ASSET_TOKEN", address(0));
        if (d.assetToken == address(0)) {
            d.assetToken = address(new SimpleErc20("Siphon Vault Asset", "SVA"));
        }
        d.dstToken = vm.envOr("SETTLEMENT_DST_TOKEN", address(0));
        if (d.dstToken == address(0)) {
            d.dstToken = address(new SimpleErc20("Siphon Swap Dst", "SVD"));
        }

        d.assets = address(new Erc20AssetAdapter());
        if (d.swapRouter != address(0)) {
            d.settlement = address(new UniswapV3SettlementAdapter(d.swapRouter));
        } else {
            d.settlement = address(new Erc20SettlementAdapter());
        }

        d.vault = address(
            new VaultKernel(
                PublicInputs.PROGRAM_VERSION,
                d.governance,
                VerifierRegistry(d.registry),
                ComplianceHub(d.hub),
                IAssetAdapter(d.assets),
                PayeeCodecEvm(d.payees),
                PoseidonHasher2(d.hasher),
                ISettlementAdapter(d.settlement)
            )
        );

        Erc20AssetAdapter(d.assets).setVault(d.vault);
        if (d.swapRouter != address(0)) {
            UniswapV3SettlementAdapter(d.settlement).setVault(d.vault);
        } else {
            Erc20SettlementAdapter(d.settlement).setVault(d.vault);
        }

        if (msg.sender == d.governance) {
            VaultKernel(d.vault).setTokenAllowed(d.assetToken, true);
            VaultKernel(d.vault).setTokenAllowed(d.dstToken, true);
            VaultKernel(d.vault).approveAssetOutbound(d.assetToken, d.assets, type(uint256).max);
            VaultKernel(d.vault).approveAssetOutbound(d.dstToken, d.assets, type(uint256).max);
            VaultKernel(d.vault).approveAssetOutbound(d.assetToken, d.settlement, type(uint256).max);
            VaultKernel(d.vault).approveAssetOutbound(d.dstToken, d.settlement, type(uint256).max);
        }

        if (settlementLiq > 0 && d.swapRouter == address(0)) {
            SimpleErc20(d.dstToken).mint(msg.sender, settlementLiq);
            SimpleErc20(d.dstToken).approve(d.settlement, settlementLiq);
            Erc20SettlementAdapter(d.settlement).fundLiquidity(d.dstToken, settlementLiq);
        }

        if (registerVerifier && minDelay == 0 && msg.sender == d.governance) {
            bytes32 programHash = keccak256(d.router.code);
            VerifierRegistry(d.registry).registerVerifier(
                PublicInputs.PROGRAM_VERSION, d.router, programHash
            );
        } else if (registerVerifier && minDelay == 0) {
            console2.log("SKIP registerVerifier: broadcaster != GOVERNANCE_ADDRESS - use BootstrapVault");
        }

        if (pauseDeposits) {
            VaultKernel(d.vault).setDepositsPaused(true);
        }

        vm.stopBroadcast();

        d.deployBlock = block.number;
        // Only a real broadcast produces contracts. Persisting from a simulation wrote a
        // complete, plausible deployed_addresses.json for a deploy that never mined — the
        // failure mode that had anvil sitting at block 0 while the record looked perfect, and
        // that would have had aspv2 wired to twenty addresses with no code.
        if (
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
                || vm.isContext(VmSafe.ForgeContext.ScriptResume)
        ) {
            _persist(d, verifiers);
        } else {
            console2.log("DRY RUN - no deployment record written. Re-run with --broadcast.");
        }
        _summary(d, verifiers, minDelay, registerVerifier, pauseDeposits);
    }

    function _persist(Deployment memory d, ActionRouterDeploy.VerifierBundle memory v) internal {
        uint256 chainId = block.chainid;
        string memory dir = string.concat("deployments/chain-", vm.toString(chainId));
        vm.createDir(dir, true);

        string memory obj = "deployment";
        vm.serializeAddress(obj, "VaultKernel", d.vault);
        vm.serializeAddress(obj, "ComplianceHub", d.hub);
        vm.serializeAddress(obj, "VerifierRegistry", d.registry);
        vm.serializeAddress(obj, "SpendActionGroth16Router", d.router);
        vm.serializeAddress(obj, "AssetToken", d.assetToken);
        vm.serializeAddress(obj, "SettlementDstToken", d.dstToken);
        vm.serializeAddress(obj, "SwapRouter", d.swapRouter);
        vm.serializeAddress(obj, "Erc20AssetAdapter", d.assets);
        vm.serializeAddress(obj, "SettlementAdapter", d.settlement);
        vm.serializeAddress(obj, "PayeeCodecEvm", d.payees);
        vm.serializeAddress(obj, "PoseidonHasher2", d.hasher);
        vm.serializeAddress(obj, "Governance", d.governance);
        vm.serializeAddress(obj, "Postman", d.postman);
        vm.serializeUint(obj, "ProgramVersion", PublicInputs.PROGRAM_VERSION);
        vm.serializeUint(obj, "DeployBlock", d.deployBlock);
        // All fourteen. The record used to list eight, so anything reading it to check verifier
        // coverage silently saw a partial deploy as a complete one.
        vm.serializeAddress(obj, "SpendWithdrawVerifier1", v.withdraw1);
        vm.serializeAddress(obj, "SpendWithdrawVerifier2", v.withdraw2);
        vm.serializeAddress(obj, "SpendWithdrawVerifier3", v.withdraw3);
        vm.serializeAddress(obj, "SpendWithdrawVerifier4", v.withdraw4);
        vm.serializeAddress(obj, "SpendWithdrawVerifier5", v.withdraw5);
        vm.serializeAddress(obj, "SpendWithdrawVerifier6", v.withdraw6);
        vm.serializeAddress(obj, "SpendMergeVerifier2", v.merge2);
        vm.serializeAddress(obj, "SpendMergeVerifier3", v.merge3);
        vm.serializeAddress(obj, "SpendMergeVerifier4", v.merge4);
        vm.serializeAddress(obj, "SpendMergeVerifier5", v.merge5);
        vm.serializeAddress(obj, "SpendMergeVerifier6", v.merge6);
        vm.serializeAddress(obj, "SpendSwapVerifier", v.swap);
        vm.serializeAddress(obj, "SpendSplitVerifier", v.split);
        string memory json = vm.serializeAddress(obj, "SpendRagequitVerifier", v.ragequit);

        string memory path = string.concat(dir, "/deployed_addresses.json");
        vm.writeJson(json, path);
        console2.log("Wrote", path);
    }

    function _summary(
        Deployment memory d,
        ActionRouterDeploy.VerifierBundle memory v,
        uint256 minDelay,
        bool registerVerifier,
        bool pauseDeposits
    ) internal view {
        console2.log("");
        console2.log("======== DEPLOYMENT SUMMARY (D1) ========");
        console2.log("Chain ID", block.chainid);
        console2.log("ProgramVersion", PublicInputs.PROGRAM_VERSION);
        console2.log("VaultKernel", d.vault);
        console2.log("AssetToken", d.assetToken);
        console2.log("DstToken", d.dstToken);
        console2.log("SettlementAdapter", d.settlement);
        console2.log("SwapRouter", d.swapRouter);
        console2.log("ComplianceHub", d.hub);
        console2.log("VerifierRegistry", d.registry);
        console2.log("SpendActionGroth16Router", d.router);
        console2.log("Verifier registered", registerVerifier && minDelay == 0 && msg.sender == d.governance);
        console2.log("Deposits paused", pauseDeposits);
        console2.log("Deploy block", d.deployBlock);
        console2.log("=========================================");
        console2.log("SpendWithdrawVerifier1", v.withdraw1);
    }
}

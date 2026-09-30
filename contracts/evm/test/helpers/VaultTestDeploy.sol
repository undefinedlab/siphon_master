// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {PublicInputs} from "../../src/libraries/PublicInputs.sol";
import {VerifierRegistry} from "../../src/VerifierRegistry.sol";
import {ComplianceHub} from "../../src/ComplianceHub.sol";
import {VaultKernel} from "../../src/VaultKernel.sol";
import {PayeeCodecEvm} from "../../src/payees/PayeeCodecEvm.sol";
import {PoseidonHasher2} from "../../src/hashers/PoseidonHasher2.sol";
import {Erc20AssetAdapter} from "../../src/adapters/Erc20AssetAdapter.sol";
import {Erc20SettlementAdapter} from "../../src/adapters/Erc20SettlementAdapter.sol";
import {UniswapV3SettlementAdapter} from "../../src/adapters/UniswapV3SettlementAdapter.sol";
import {MockSwapRouter} from "../../src/adapters/MockSwapRouter.sol";
import {SimpleErc20} from "../../src/tokens/SimpleErc20.sol";
import {SpendActionGroth16Router} from "../../src/SpendActionGroth16Router.sol";
import {ActionRouterDeploy} from "../../script/ActionRouterDeploy.sol";
import {PoseidonLink} from "./PoseidonLink.sol";

/// @dev Foundry-only digest verifier for registry ordering tests (not production bytecode).
contract DigestSpendVerifier {
    address public immutable owner;
    bytes32 public expectedDigest;

    error DigestNotSet();
    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function setExpectedDigest(bytes32 digest) external {
        if (msg.sender != owner) revert NotOwner();
        expectedDigest = digest;
    }

    function setExpectedPublics(uint256[25] calldata publicInputs) external {
        if (msg.sender != owner) revert NotOwner();
        expectedDigest = PublicInputs.commitDigest(publicInputs);
    }

    function verifySpend(
        uint256[25] calldata publicInputs,
        uint256[8] calldata proof
    ) external view returns (bool) {
        if (expectedDigest == bytes32(0)) revert DigestNotSet();
        if (proof[0] == 0) return false;
        return PublicInputs.commitDigest(publicInputs) == expectedDigest;
    }
}

/// @dev OMEGA F-5 PoC sink: must never be invoked when `checkKernelPre` fails first.
contract SpendVerifyTrap {
    error VerifyCalled();

    function verifySpend(
        uint256[25] calldata,
        uint256[8] calldata
    ) external pure returns (bool) {
        revert VerifyCalled();
    }
}

/// @notice Deploy vault stack with multi-token ERC-20 adapters + production Groth16 router.
library VaultTestDeploy {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    struct Stack {
        VaultKernel vault;
        VerifierRegistry registry;
        ComplianceHub hub;
        SpendActionGroth16Router router;
        Erc20AssetAdapter assets;
        Erc20SettlementAdapter settlement;
        SimpleErc20 assetToken;
        SimpleErc20 dstToken;
        PayeeCodecEvm payees;
        PoseidonHasher2 hasher;
    }

    function _wireAllowances(Stack memory s, address gov) private {
        VM.prank(gov);
        s.vault.setTokenAllowed(address(s.assetToken), true);
        VM.prank(gov);
        s.vault.setTokenAllowed(address(s.dstToken), true);
        VM.prank(gov);
        s.vault.approveAssetOutbound(address(s.assetToken), address(s.assets), type(uint256).max);
        VM.prank(gov);
        s.vault.approveAssetOutbound(address(s.dstToken), address(s.assets), type(uint256).max);
        VM.prank(gov);
        s.vault.approveAssetOutbound(address(s.assetToken), address(s.settlement), type(uint256).max);
        VM.prank(gov);
        s.vault.approveAssetOutbound(address(s.dstToken), address(s.settlement), type(uint256).max);
    }

    function deployReal(address gov, address postman) internal returns (Stack memory s) {
        PoseidonLink.etch();
        s.assetToken = new SimpleErc20("Siphon Asset", "SASSET");
        s.dstToken = new SimpleErc20("Siphon Dst", "SDST");
        s.registry = new VerifierRegistry(gov, 0);
        s.hub = new ComplianceHub(postman, 0);
        s.router = ActionRouterDeploy.deploy();
        s.payees = new PayeeCodecEvm();
        s.hasher = new PoseidonHasher2();
        s.assets = new Erc20AssetAdapter();
        s.settlement = new Erc20SettlementAdapter();

        VM.prank(gov);
        s.registry.registerVerifier(
            PublicInputs.PROGRAM_VERSION,
            address(s.router),
            keccak256(address(s.router).code)
        );

        s.vault = new VaultKernel(
            PublicInputs.PROGRAM_VERSION,
            gov,
            s.registry,
            s.hub,
            s.assets,
            s.payees,
            s.hasher,
            s.settlement
        );
        s.assets.setVault(address(s.vault));
        s.settlement.setVault(address(s.vault));
        _wireAllowances(s, gov);
    }

    function deployWithDigestVerifier(address gov, address postman)
        internal
        returns (Stack memory s, DigestSpendVerifier digest)
    {
        PoseidonLink.etch();
        s.assetToken = new SimpleErc20("Siphon Asset", "SASSET");
        s.dstToken = new SimpleErc20("Siphon Dst", "SDST");
        s.registry = new VerifierRegistry(gov, 0);
        s.hub = new ComplianceHub(postman, 0);
        s.router = ActionRouterDeploy.deploy();
        s.payees = new PayeeCodecEvm();
        s.hasher = new PoseidonHasher2();
        s.assets = new Erc20AssetAdapter();
        s.settlement = new Erc20SettlementAdapter();
        digest = new DigestSpendVerifier();

        VM.prank(gov);
        s.registry.registerVerifier(
            PublicInputs.PROGRAM_VERSION,
            address(digest),
            keccak256(address(digest).code)
        );

        s.vault = new VaultKernel(
            PublicInputs.PROGRAM_VERSION,
            gov,
            s.registry,
            s.hub,
            s.assets,
            s.payees,
            s.hasher,
            s.settlement
        );
        s.assets.setVault(address(s.vault));
        s.settlement.setVault(address(s.vault));
        _wireAllowances(s, gov);
    }

    function deployWithVerifyTrap(address gov, address postman)
        internal
        returns (Stack memory s, SpendVerifyTrap trap)
    {
        PoseidonLink.etch();
        s.assetToken = new SimpleErc20("Siphon Asset", "SASSET");
        s.dstToken = new SimpleErc20("Siphon Dst", "SDST");
        s.registry = new VerifierRegistry(gov, 0);
        s.hub = new ComplianceHub(postman, 0);
        s.payees = new PayeeCodecEvm();
        s.hasher = new PoseidonHasher2();
        s.assets = new Erc20AssetAdapter();
        s.settlement = new Erc20SettlementAdapter();
        trap = new SpendVerifyTrap();

        VM.prank(gov);
        s.registry.registerVerifier(
            PublicInputs.PROGRAM_VERSION,
            address(trap),
            keccak256(address(trap).code)
        );

        s.vault = new VaultKernel(
            PublicInputs.PROGRAM_VERSION,
            gov,
            s.registry,
            s.hub,
            s.assets,
            s.payees,
            s.hasher,
            s.settlement
        );
        s.assets.setVault(address(s.vault));
        s.settlement.setVault(address(s.vault));
        _wireAllowances(s, gov);
    }

    /// @dev Uniswap path with MockSwapRouter for measured fill tests.
    function deployWithMockUniswap(address gov, address postman)
        internal
        returns (Stack memory s, MockSwapRouter mockRouter, UniswapV3SettlementAdapter uni)
    {
        PoseidonLink.etch();
        s.assetToken = new SimpleErc20("Siphon Asset", "SASSET");
        s.dstToken = new SimpleErc20("Siphon Dst", "SDST");
        s.registry = new VerifierRegistry(gov, 0);
        s.hub = new ComplianceHub(postman, 0);
        s.router = ActionRouterDeploy.deploy();
        s.payees = new PayeeCodecEvm();
        s.hasher = new PoseidonHasher2();
        s.assets = new Erc20AssetAdapter();
        mockRouter = new MockSwapRouter();
        uni = new UniswapV3SettlementAdapter(address(mockRouter));

        VM.prank(gov);
        s.registry.registerVerifier(
            PublicInputs.PROGRAM_VERSION,
            address(s.router),
            keccak256(address(s.router).code)
        );

        s.vault = new VaultKernel(
            PublicInputs.PROGRAM_VERSION,
            gov,
            s.registry,
            s.hub,
            s.assets,
            s.payees,
            s.hasher,
            uni
        );
        s.assets.setVault(address(s.vault));
        uni.setVault(address(s.vault));
        VM.prank(gov);
        s.vault.setTokenAllowed(address(s.assetToken), true);
        VM.prank(gov);
        s.vault.setTokenAllowed(address(s.dstToken), true);
        VM.prank(gov);
        s.vault.approveAssetOutbound(address(s.assetToken), address(s.assets), type(uint256).max);
        VM.prank(gov);
        s.vault.approveAssetOutbound(address(s.dstToken), address(s.assets), type(uint256).max);
        VM.prank(gov);
        s.vault.approveAssetOutbound(address(s.assetToken), address(uni), type(uint256).max);
        // Fund mock router with dst inventory for 1:1 fills.
        s.dstToken.mint(address(mockRouter), type(uint128).max);
    }
}

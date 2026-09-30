// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";
import {Vm} from "forge-std/Vm.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {VaultKernel} from "../src/VaultKernel.sol";
import {IVaultKernel} from "../src/interfaces/IVaultKernel.sol";
import {Erc20AssetAdapter} from "../src/adapters/Erc20AssetAdapter.sol";
import {Erc20SettlementAdapter} from "../src/adapters/Erc20SettlementAdapter.sol";
import {UniswapV3SettlementAdapter} from "../src/adapters/UniswapV3SettlementAdapter.sol";
import {MockSwapRouter} from "../src/adapters/MockSwapRouter.sol";
import {
    VaultTestDeploy,
    DigestSpendVerifier
} from "./helpers/VaultTestDeploy.sol";

/// @notice OVERLORD DELTA — contracts-v2 D1 findings F-1 / F-2 / F-3.
contract OverlordContractsD1Test is Test {
    /// @dev foundry.toml links Poseidon to canonical addresses that do not exist in the
    /// test EVM; etch it before anything hashes. No-op once present.
    function setUp() public {
        PoseidonLink.etch();
    }


    function test_F1_swapNonzeroPayeeReverts() public {
        address gov = makeAddr("gov");
        address postman = makeAddr("postman");
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) =
            VaultTestDeploy.deployWithDigestVerifier(gov, postman);

        uint256 stateRoot = s.vault.notes().currentRoot();
        vm.prank(postman);
        s.hub.updateAdmittedRoot(1);
        vm.prank(postman);
        s.hub.updateRevokedRoot(1);

        address src = address(s.assetToken);
        address dst = address(s.dstToken);
        uint256 srcId = uint160(src);
        uint256 dstId = uint160(dst);

        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_SWAP;
        pi[1] = 1;
        pi[2] = stateRoot;
        pi[3] = 1;
        pi[4] = 1;
        pi[5] = 100; // primary
        pi[6] = 0;
        pi[7] = 0;
        pi[9] = 42; // nullifier hash
        pi[15] = 1; // OVERLORD F-1 PoC: nonzero payeeId
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[17] = 0; // pool
        pi[18] = dstId;
        pi[19] = 3000;
        pi[20] = 50; // minOut
        pi[21] = 1; // outputPre
        pi[22] = 99; // destCommitment
        pi[23] = srcId;

        digest.setExpectedPublics(pi);
        uint256[8] memory proof;
        proof[0] = 1;

        s.assetToken.mint(address(s.vault), 100);
        s.dstToken.mint(address(s.settlement), 1000);
        vm.prank(gov);
        s.vault.approveAssetOutbound(src, address(s.settlement), type(uint256).max);

        vm.expectRevert(VaultKernel.SwapPayeeMustBeZero.selector);
        s.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
    }

    function test_F2_depositedDepositorNotIndexed() public {
        address gov = makeAddr("gov");
        address postman = makeAddr("postman");
        VaultTestDeploy.Stack memory s = VaultTestDeploy.deployReal(gov, postman);
        address depositor = makeAddr("depositor");

        uint256 amount = 1000;
        s.assetToken.mint(depositor, amount);
        vm.startPrank(depositor);
        s.assetToken.approve(address(s.assets), amount);

        vm.recordLogs();
        s.vault.deposit(address(s.assetToken), amount, 4242, 123);
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 depSig = keccak256("Deposited(address,address,uint256,uint256,uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != depSig) continue;
            found = true;
            // Indexed: signature + token only (2 topics). Depositor is NOT a topic.
            assertEq(logs[i].topics.length, 2, "F-2: depositor must not be indexed");
            assertEq(address(uint160(uint256(logs[i].topics[1]))), address(s.assetToken));
            break;
        }
        assertTrue(found, "Deposited log missing");
    }

    function test_F3_setVaultRejectsNonDeployer() public {
        Erc20AssetAdapter assets = new Erc20AssetAdapter();
        Erc20SettlementAdapter settlement = new Erc20SettlementAdapter();
        MockSwapRouter router = new MockSwapRouter();
        UniswapV3SettlementAdapter uni = new UniswapV3SettlementAdapter(address(router));

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(Erc20AssetAdapter.NotDeployer.selector);
        assets.setVault(attacker);

        vm.prank(attacker);
        vm.expectRevert(Erc20SettlementAdapter.NotDeployer.selector);
        settlement.setVault(attacker);

        vm.prank(attacker);
        vm.expectRevert(UniswapV3SettlementAdapter.NotDeployer.selector);
        uni.setVault(attacker);

        // Deployer can still bind once.
        assets.setVault(makeAddr("vault"));
        settlement.setVault(makeAddr("vault"));
        uni.setVault(makeAddr("vault"));
    }

    function _zeroSplit() internal pure returns (uint256[8] memory z) {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {CommitmentLib} from "../src/libraries/CommitmentLib.sol";
import {VaultKernel} from "../src/VaultKernel.sol";
import {IVaultKernel} from "../src/interfaces/IVaultKernel.sol";
import {
    VaultTestDeploy,
    DigestSpendVerifier
} from "./helpers/VaultTestDeploy.sol";

/// @notice Protocol surplus: SWAP accrues claimable; gov mints note from queue.
contract ProtocolSurplusNoteTest is Test {
    /// @dev foundry.toml links Poseidon to canonical addresses that do not exist in the
    /// test EVM; etch it before anything hashes. No-op once present.
    function setUp() public {
        PoseidonLink.etch();
    }

    event ProtocolSurplusAccrued(address indexed token, uint256 amount, uint256 claimableAfter);
    event ProtocolSurplusNote(
        address indexed token,
        uint256 amount,
        uint256 commitment,
        uint256 stateRootAfter,
        uint256 queueIndex
    );

    function test_surplusAccruesThenGovMintsNote() public {
        address gov = makeAddr("gov");
        address postman = makeAddr("postman");
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) =
            VaultTestDeploy.deployWithDigestVerifier(gov, postman);

        uint256 protoLabel = 777001;
        uint256 protoPre = CommitmentLib.precommitment(888001, 999001);
        vm.prank(gov);
        s.vault.setProtocolNoteConfig(protoLabel, protoPre);

        vm.prank(postman);
        s.hub.updateAdmittedRoot(1);
        vm.prank(postman);
        s.hub.updateRevokedRoot(1);

        address src = address(s.assetToken);
        address dst = address(s.dstToken);
        uint256 amountIn = 100;
        uint256 minOut = 80;
        uint256 surplus = amountIn - minOut;

        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_SWAP;
        pi[1] = 1;
        pi[2] = s.vault.notes().currentRoot();
        pi[3] = 1;
        pi[4] = 1;
        pi[5] = amountIn;
        pi[9] = 42;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[18] = uint160(dst);
        pi[19] = 3000;
        pi[20] = minOut;
        pi[21] = 1;
        pi[22] = 99;
        pi[23] = uint160(src);

        digest.setExpectedPublics(pi);
        uint256[8] memory proof;
        proof[0] = 1;

        s.assetToken.mint(address(s.vault), amountIn);
        s.dstToken.mint(address(s.settlement), 1000);
        vm.prank(gov);
        s.vault.approveAssetOutbound(src, address(s.settlement), type(uint256).max);

        uint256 leavesBefore = s.vault.notes().leafCount();
        vm.expectEmit(true, false, false, true);
        emit ProtocolSurplusAccrued(dst, surplus, surplus);

        s.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );

        // User dest only on swap path (+0 change).
        assertEq(s.vault.notes().leafCount(), leavesBefore + 1);
        assertEq(s.vault.protocolClaimable(dst), surplus);
        assertEq(s.vault.protocolPresRemaining(), 1);

        uint256 expectedC = CommitmentLib.commitmentHash(
            surplus, protoLabel, uint160(dst), protoPre
        );
        vm.expectEmit(true, false, false, false);
        emit ProtocolSurplusNote(dst, surplus, expectedC, 0, 0);

        vm.prank(gov);
        (uint256 c, uint256 qIdx) = s.vault.mintProtocolSurplusNote(dst, surplus);
        assertEq(c, expectedC);
        assertEq(qIdx, 0);
        assertEq(s.vault.notes().leafCount(), leavesBefore + 2);
        assertEq(s.vault.protocolClaimable(dst), 0);
        assertEq(s.vault.protocolPresRemaining(), 0);
    }

    function test_surplusWithoutConfigStillAccrues() public {
        address gov = makeAddr("gov");
        address postman = makeAddr("postman");
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) =
            VaultTestDeploy.deployWithDigestVerifier(gov, postman);

        vm.prank(postman);
        s.hub.updateAdmittedRoot(1);
        vm.prank(postman);
        s.hub.updateRevokedRoot(1);

        address src = address(s.assetToken);
        address dst = address(s.dstToken);

        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_SWAP;
        pi[1] = 1;
        pi[2] = s.vault.notes().currentRoot();
        pi[3] = 1;
        pi[4] = 1;
        pi[5] = 100;
        pi[9] = 42;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[18] = uint160(dst);
        pi[19] = 3000;
        pi[20] = 80;
        pi[21] = 1;
        pi[22] = 99;
        pi[23] = uint160(src);

        digest.setExpectedPublics(pi);
        uint256[8] memory proof;
        proof[0] = 1;

        s.assetToken.mint(address(s.vault), 100);
        s.dstToken.mint(address(s.settlement), 1000);
        vm.prank(gov);
        s.vault.approveAssetOutbound(src, address(s.settlement), type(uint256).max);

        s.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
        assertEq(s.vault.protocolClaimable(dst), 20);

        vm.expectRevert(VaultKernel.ProtocolNoteNotConfigured.selector);
        vm.prank(gov);
        s.vault.mintProtocolSurplusNote(dst, 20);
    }

    function _zeroSplit() internal pure returns (uint256[8] memory z) {}
}

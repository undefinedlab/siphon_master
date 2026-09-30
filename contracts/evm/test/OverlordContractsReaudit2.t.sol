// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {CommitmentLib} from "../src/libraries/CommitmentLib.sol";
import {VaultKernel} from "../src/VaultKernel.sol";
import {IVaultKernel} from "../src/interfaces/IVaultKernel.sol";
import {UniswapV3SettlementAdapter} from "../src/adapters/UniswapV3SettlementAdapter.sol";
import {MockSwapRouter} from "../src/adapters/MockSwapRouter.sol";
import {
    VaultTestDeploy,
    DigestSpendVerifier
} from "./helpers/VaultTestDeploy.sol";

/// @notice OVERLORD DELTA — contracts-v2 re-audit F-1…F-5 (duplicate pre / claimable / fee / zero primary / queueIndex).
contract OverlordContractsReaudit2Test is Test {
    /// @dev foundry.toml links Poseidon to canonical addresses that do not exist in the
    /// test EVM; etch it before anything hashes. No-op once present.
    function setUp() public {
        PoseidonLink.etch();
    }

    address internal gov;
    address internal postman;

    function test_F1_duplicatePreEnqueueReverts() public {
        (VaultTestDeploy.Stack memory s,) = _boot();
        uint256 pre = CommitmentLib.precommitment(11, 12);
        vm.prank(gov);
        s.vault.setProtocolNoteConfig(777_001, pre);

        uint256[] memory dup = new uint256[](1);
        dup[0] = pre;
        vm.prank(gov);
        vm.expectRevert(VaultKernel.ProtocolPreDuplicate.selector);
        s.vault.enqueueProtocolNotePres(dup);
    }

    function test_F1_consumedPreCannotBeReEnqueued() public {
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) = _boot();
        uint256 pre = CommitmentLib.precommitment(11, 12);
        vm.prank(gov);
        s.vault.setProtocolNoteConfig(777_001, pre);

        _swapAccrue(s, digest, 100, 80, 42);
        vm.prank(gov);
        s.vault.mintProtocolSurplusNote(address(s.dstToken), 20);
        assertEq(s.vault.protocolPresRemaining(), 0);

        uint256[] memory again = new uint256[](1);
        again[0] = pre;
        vm.prank(gov);
        vm.expectRevert(VaultKernel.ProtocolPreDuplicate.selector);
        s.vault.enqueueProtocolNotePres(again);
    }

    function test_F2_tinySurplusDoesNotConsumePreQueue() public {
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) = _boot();
        uint256 pre = CommitmentLib.precommitment(11, 12);
        vm.prank(gov);
        s.vault.setProtocolNoteConfig(777_001, pre);
        assertEq(s.vault.protocolPresRemaining(), 1);

        // measured ~= amountIn; minOut = amountIn - 1 → tiny surplus without draining queue.
        _swapAccrue(s, digest, 100, 99, 42);
        assertEq(s.vault.protocolClaimable(address(s.dstToken)), 1);
        assertEq(s.vault.protocolPresRemaining(), 1, "OVERLORD F-2: swap must not consume pre");
    }

    function test_F3_badFeeReverts() public {
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) = _boot();
        uint256[25] memory pi = _baseSwapPi(s, 100, 80, 42);
        pi[19] = uint256(type(uint24).max) + 1;
        digest.setExpectedPublics(pi);
        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(VaultKernel.SwapBadFee.selector);
        s.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
    }

    function test_F4_zeroPrimaryWithdrawReverts() public {
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) = _boot();
        address token = address(s.assetToken);
        address payee = makeAddr("payee");
        bytes memory raw = abi.encodePacked(payee);

        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_WITHDRAW;
        pi[1] = 1;
        pi[2] = s.vault.notes().currentRoot();
        pi[3] = 1;
        pi[4] = 1;
        pi[5] = 0; // primary
        pi[9] = 42;
        pi[15] = s.payees.payeeId(raw);
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[17] = uint160(token);
        digest.setExpectedPublics(pi);

        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(VaultKernel.ZeroPrimaryValue.selector);
        s.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: raw, splitCommitments: _zeroSplit()})
        );
    }

    function test_F5_mintEmitsQueueIndex() public {
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) = _boot();
        uint256 pre = CommitmentLib.precommitment(11, 12);
        vm.prank(gov);
        s.vault.setProtocolNoteConfig(777_001, pre);
        _swapAccrue(s, digest, 100, 80, 42);

        vm.prank(gov);
        (, uint256 qIdx) = s.vault.mintProtocolSurplusNote(address(s.dstToken), 20);
        assertEq(qIdx, 0);
    }

    function test_legacy_srcEqualsDstReverts() public {
        (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest) = _boot();
        address token = address(s.assetToken);
        uint256[25] memory pi = _baseSwapPi(s, 100, 80, 42);
        pi[18] = uint160(token);
        pi[23] = uint160(token);
        digest.setExpectedPublics(pi);
        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(VaultKernel.SwapSameAsset.selector);
        s.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
    }

    function test_legacy_uniswapSameAssetRevertsAtAdapter() public {
        MockSwapRouter router = new MockSwapRouter();
        UniswapV3SettlementAdapter adapter = new UniswapV3SettlementAdapter(address(router));
        adapter.setVault(address(this));
        address token = address(0xBEEF);
        vm.expectRevert(UniswapV3SettlementAdapter.SameAsset.selector);
        adapter.fill(0, token, token, 3000, 1, 1);
    }

    function _boot()
        internal
        returns (VaultTestDeploy.Stack memory s, DigestSpendVerifier digest)
    {
        gov = makeAddr("gov");
        postman = makeAddr("postman");
        (s, digest) = VaultTestDeploy.deployWithDigestVerifier(gov, postman);
        vm.prank(postman);
        s.hub.updateAdmittedRoot(1);
        vm.prank(postman);
        s.hub.updateRevokedRoot(1);
    }

    function _swapAccrue(
        VaultTestDeploy.Stack memory s,
        DigestSpendVerifier digest,
        uint256 amountIn,
        uint256 minOut,
        uint256 nf
    ) internal {
        address src = address(s.assetToken);
        uint256[25] memory pi = _baseSwapPi(s, amountIn, minOut, nf);
        digest.setExpectedPublics(pi);
        s.assetToken.mint(address(s.vault), amountIn);
        s.dstToken.mint(address(s.settlement), 1000);
        vm.prank(gov);
        s.vault.approveAssetOutbound(src, address(s.settlement), type(uint256).max);
        uint256[8] memory proof;
        proof[0] = 1;
        s.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
    }

    function _baseSwapPi(
        VaultTestDeploy.Stack memory s,
        uint256 amountIn,
        uint256 minOut,
        uint256 nf
    ) internal view returns (uint256[25] memory pi) {
        pi[0] = PublicInputs.ACTION_SWAP;
        pi[1] = 1;
        pi[2] = s.vault.notes().currentRoot();
        pi[3] = 1;
        pi[4] = 1;
        pi[5] = amountIn;
        pi[9] = nf;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[18] = uint160(address(s.dstToken));
        pi[19] = 3000;
        pi[20] = minOut;
        pi[21] = 1;
        pi[22] = 99 + nf;
        pi[23] = uint160(address(s.assetToken));
    }

    function _zeroSplit() internal pure returns (uint256[8] memory z) {}
}

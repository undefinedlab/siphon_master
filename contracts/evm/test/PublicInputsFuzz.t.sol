// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";
import {PublicInputs} from "../src/libraries/PublicInputs.sol";

/// @notice GF-M2: fuzz kernel pre-checks via external wrapper for expectRevert.
contract PublicInputsFuzzTest is Test {
    /// @dev foundry.toml links Poseidon to canonical addresses that do not exist in the
    /// test EVM; etch it before anything hashes. No-op once present.
    function setUp() public {
        PoseidonLink.etch();
    }

    function testFuzz_outLabelMustBeZero(uint256 noise) public {
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_WITHDRAW;
        pi[1] = 1;
        pi[8] = noise | 1;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        vm.expectRevert(PublicInputs.OutLabelMustBeZero.selector);
        this.checkPre(pi);
    }

    function testFuzz_mergePrimaryMustBeZero(uint256 primary) public {
        vm.assume(primary != 0);
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_MERGE;
        pi[1] = 2;
        pi[5] = primary;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        vm.expectRevert(PublicInputs.MergePrimaryMustBeZero.selector);
        this.checkPre(pi);
    }

    function testFuzz_mergeSecondaryMustBeZero(uint256 secondary) public {
        vm.assume(secondary != 0);
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_MERGE;
        pi[1] = 2;
        pi[5] = 0;
        pi[6] = secondary;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        vm.expectRevert(PublicInputs.MergeSecondaryMustBeZero.selector);
        this.checkPre(pi);
    }

    function testFuzz_badAction(uint256 action) public {
        vm.assume(action > PublicInputs.ACTION_RAGEQUIT);
        uint256[25] memory pi;
        pi[0] = action;
        pi[1] = 1;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        vm.expectRevert(PublicInputs.BadAction.selector);
        this.checkPre(pi);
    }

    function testFuzz_withdrawBadInputCount(uint256 n) public {
        vm.assume(n == 0 || n > 6);
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_WITHDRAW;
        pi[1] = n;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        vm.expectRevert(PublicInputs.BadInputCount.selector);
        this.checkPre(pi);
    }

    function testFuzz_mergeBadInputCount(uint256 n) public {
        vm.assume(n < 2 || n > 6);
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_MERGE;
        pi[1] = n;
        pi[5] = 0;
        pi[6] = 0;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        vm.expectRevert(PublicInputs.BadInputCount.selector);
        this.checkPre(pi);
    }

    function testFuzz_swapSplitRagequitRequireN1(uint8 action, uint256 n) public {
        action = uint8(bound(action, PublicInputs.ACTION_SWAP, PublicInputs.ACTION_RAGEQUIT));
        vm.assume(n != 1);
        uint256[25] memory pi;
        pi[0] = action;
        pi[1] = n;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        vm.expectRevert(PublicInputs.BadInputCount.selector);
        this.checkPre(pi);
    }

    function testFuzz_paddingNullifierNonZero(uint8 nActive, uint8 padSlot, uint256 noise) public {
        nActive = uint8(bound(nActive, 1, 5));
        padSlot = uint8(bound(padSlot, nActive, 5));
        vm.assume(noise != 0);
        uint256[25] memory pi = _validWithdraw(nActive);
        pi[9 + padSlot] = noise;
        vm.expectRevert(PublicInputs.PaddingNullifierNonZero.selector);
        this.checkPre(pi);
    }

    function testFuzz_withdrawUnusedMuxNonZero(uint8 muxIdx, uint256 noise) public {
        muxIdx = uint8(bound(muxIdx, 18, 24)); // [17] = assetId (D1)
        vm.assume(noise != 0);
        uint256[25] memory pi = _validWithdraw(1);
        pi[muxIdx] = noise;
        vm.expectRevert(PublicInputs.UnusedMuxNonZero.selector);
        this.checkPre(pi);
    }

    function testFuzz_swapUnusedMuxNonZero(uint8 muxIdx, uint256 noise) public {
        muxIdx = uint8(bound(muxIdx, 24, 24)); // [17..23] used; only [24] unused
        vm.assume(noise != 0);
        uint256[25] memory pi = _validSwap();
        pi[muxIdx] = noise;
        vm.expectRevert(PublicInputs.UnusedMuxNonZero.selector);
        this.checkPre(pi);
    }

    function testFuzz_splitUnusedMuxNonZero(uint8 muxIdx, uint256 noise) public {
        muxIdx = uint8(bound(muxIdx, 18, 24));
        vm.assume(noise != 0);
        uint256[25] memory pi = _validSplit();
        pi[muxIdx] = noise;
        vm.expectRevert(PublicInputs.UnusedMuxNonZero.selector);
        this.checkPre(pi);
    }

    function testFuzz_badProgramVersion(uint256 version) public {
        vm.assume(version != PublicInputs.PROGRAM_VERSION);
        uint256[25] memory pi = _validWithdraw(1);
        pi[16] = version;
        vm.expectRevert(PublicInputs.BadProgramVersion.selector);
        this.checkPre(pi);
    }

    function test_validMinimalLimbsPass() public pure {
        PublicInputs.checkKernelPre(_validWithdraw(1), PublicInputs.PROGRAM_VERSION);
        PublicInputs.checkKernelPre(_validWithdraw(6), PublicInputs.PROGRAM_VERSION);
        PublicInputs.checkKernelPre(_validMerge(2), PublicInputs.PROGRAM_VERSION);
        PublicInputs.checkKernelPre(_validMerge(6), PublicInputs.PROGRAM_VERSION);
        PublicInputs.checkKernelPre(_validSwap(), PublicInputs.PROGRAM_VERSION);
        PublicInputs.checkKernelPre(_validSplit(), PublicInputs.PROGRAM_VERSION);
        PublicInputs.checkKernelPre(_validRagequit(), PublicInputs.PROGRAM_VERSION);
    }

    function checkPre(uint256[25] memory pi) external pure {
        PublicInputs.checkKernelPre(pi, PublicInputs.PROGRAM_VERSION);
    }

    function _validWithdraw(uint256 n) internal pure returns (uint256[25] memory pi) {
        pi[0] = PublicInputs.ACTION_WITHDRAW;
        pi[1] = n;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[17] = 1; // assetId (D1)
    }

    function _validMerge(uint256 n) internal pure returns (uint256[25] memory pi) {
        pi[0] = PublicInputs.ACTION_MERGE;
        pi[1] = n;
        pi[5] = 0;
        pi[6] = 0;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
    }

    function _validSwap() internal pure returns (uint256[25] memory pi) {
        pi[0] = PublicInputs.ACTION_SWAP;
        pi[1] = 1;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        // mux 17–23 may be non-zero for swap; unused starts at 24
        pi[17] = 1;
        pi[22] = 1;
        pi[23] = 1; // srcAssetId
    }

    function _validSplit() internal pure returns (uint256[25] memory pi) {
        pi[0] = PublicInputs.ACTION_SPLIT;
        pi[1] = 1;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[17] = 1; // splitRoot
    }

    function _validRagequit() internal pure returns (uint256[25] memory pi) {
        pi[0] = PublicInputs.ACTION_RAGEQUIT;
        pi[1] = 1;
        pi[8] = 0;
        pi[15] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[17] = 1; // payeeId mux
        pi[18] = 1; // assetId (D1)
    }
}

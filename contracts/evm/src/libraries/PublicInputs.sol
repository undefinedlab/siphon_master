// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PublicInputs
/// @notice Fixed 25-limb layout + kernel pre-checks — PROTOCOL v3.5.0 §4 / §8.2 (D1).
library PublicInputs {
    uint256 internal constant WIDTH = 25;
    uint256 internal constant PROGRAM_VERSION = 3;

    uint256 internal constant ACTION_WITHDRAW = 0;
    uint256 internal constant ACTION_MERGE = 1;
    uint256 internal constant ACTION_SWAP = 2;
    uint256 internal constant ACTION_SPLIT = 3;
    uint256 internal constant ACTION_RAGEQUIT = 4;

    error OutLabelMustBeZero();
    error MergePrimaryMustBeZero();
    error MergeSecondaryMustBeZero();
    error BadProgramVersion();
    error BadAction();
    error BadInputCount();
    error PaddingNullifierNonZero();
    error UnusedMuxNonZero();

    function action(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[0];
    }

    function inputCount(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[1];
    }

    function stateRoot(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[2];
    }

    function admittedRoot(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[3];
    }

    function revokedRoot(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[4];
    }

    function primaryValue(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[5];
    }

    function secondaryValue(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[6];
    }

    function outCommitment(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[7];
    }

    function outLabel(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[8];
    }

    function payeeId(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[15];
    }

    function programVersion(uint256[WIDTH] memory pi) internal pure returns (uint256) {
        return pi[16];
    }

    /// @notice Kernel pre-checks shared by VaultKernel before finalize (M3/M4).
    function checkKernelPre(uint256[WIDTH] memory pi, uint256 vaultProgramVersion)
        internal
        pure
    {
        if (pi[16] != vaultProgramVersion) revert BadProgramVersion();
        if (pi[8] != 0) revert OutLabelMustBeZero();

        uint256 a = pi[0];
        uint256 n = pi[1];
        if (a > ACTION_RAGEQUIT) revert BadAction();

        if (a == ACTION_WITHDRAW) {
            if (n < 1 || n > 6) revert BadInputCount();
        } else if (a == ACTION_MERGE) {
            if (n < 2 || n > 6) revert BadInputCount();
            if (pi[5] != 0) revert MergePrimaryMustBeZero();
            if (pi[6] != 0) revert MergeSecondaryMustBeZero();
        } else {
            // SWAP / SPLIT / RAGEQUIT
            if (n != 1) revert BadInputCount();
        }

        for (uint256 i = n; i < 6; i++) {
            if (pi[9 + i] != 0) revert PaddingNullifierNonZero();
        }

        _checkUnusedMux(pi, a);
    }

    /// @dev PROTOCOL §4.2 — unused mux slots MUST be 0 (D1 asset limbs).
    function _checkUnusedMux(uint256[WIDTH] memory pi, uint256 a) private pure {
        uint256 start = 17;
        if (a == ACTION_WITHDRAW) {
            start = 18; // [17] = assetId
        } else if (a == ACTION_SWAP) {
            start = 24; // [17..23] used; [24] must be 0
        } else if (a == ACTION_SPLIT) {
            start = 18; // [17] = splitRoot
        } else if (a == ACTION_RAGEQUIT) {
            start = 19; // [17] payee, [18] assetId
        }
        for (uint256 i = start; i < WIDTH; i++) {
            if (pi[i] != 0) revert UnusedMuxNonZero();
        }
    }

    /// @dev Digest used by DigestSpendVerifier / Foundry equality tests (GF-H2).
    function commitDigest(uint256[WIDTH] memory pi) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(pi));
    }
}

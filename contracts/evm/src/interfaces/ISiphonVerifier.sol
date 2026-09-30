// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISiphonVerifier
/// @notice Groth16 spend verifier for one `programVersion` (PROTOCOL §4.6).
interface ISiphonVerifier {
    /// @param publicInputs Canonical 25 BN254 limbs.
    /// @param proof Groth16 proof (8 words: pA, pB swapped, pC).
    function verifySpend(
        uint256[25] calldata publicInputs,
        uint256[8] calldata proof
    ) external view returns (bool);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice snarkjs-exported Groth16 verifier (per-circuit).
interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[25] calldata _pubSignals
    ) external view returns (bool);
}

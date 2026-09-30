// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVerifierRegistry
/// @notice Register-only map of programVersion → verifier (ARCHITECTURE-GREENFIELD §6.2).
interface IVerifierRegistry {
    event VerifierRegistered(
        uint256 indexed version, address verifier, bytes32 programHash
    );

    function governance() external view returns (address);

    function verifiers(uint256 version) external view returns (address);

    function programHashes(uint256 version) external view returns (bytes32);

    /// @notice Queue a register; required when registry `minDelay > 0`.
    function proposeVerifier(uint256 version, address verifier, bytes32 programHash)
        external;

    /// @notice Cancel a matured-but-unregistered proposal so governance can re-propose.
    function cancelProposal(uint256 version) external;

    /// @dev Reverts if version already registered (no in-place swap).
    ///      When `minDelay > 0`, a matching matured proposal is required.
    function registerVerifier(uint256 version, address verifier, bytes32 programHash)
        external;

    /// @notice Verify via the registered verifier for `version`.
    function verifySpend(
        uint256 version,
        uint256[25] calldata publicInputs,
        uint256[8] calldata proof
    ) external view returns (bool);
}

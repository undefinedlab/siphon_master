// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IComplianceHub
/// @notice Current ASP + SMT roots only — PROTOCOL §2.6 / §7 (no label map).
interface IComplianceHub {
    event AdmittedRootUpdated(uint256 newRoot);
    event RevokedRootUpdated(uint256 prev, uint256 newRoot);

    function admittedRoot() external view returns (uint256);

    function revokedRoot() external view returns (uint256);

    function postman() external view returns (address);

    function admitEpochSeconds() external view returns (uint256);

    function admittedRootIsCurrent(uint256 root) external view returns (bool);

    function revokedRootIsCurrent(uint256 root) external view returns (bool);

    /// @dev Postman-only. Enforces `admitEpochSeconds` after the first publish.
    ///      Previously published roots cannot be republished (append-only pointer).
    function updateAdmittedRoot(uint256 newRoot) external;

    /// @dev Postman-only. Revoke publishes immediately; previously used roots cannot return.
    function updateRevokedRoot(uint256 newRoot) external;
}

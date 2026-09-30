// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IComplianceHub} from "./interfaces/IComplianceHub.sol";

/// @title ComplianceHub
/// @notice Single current admittedRoot + revokedRoot (no ASP ring).
contract ComplianceHub is IComplianceHub {
    address public immutable override postman;
    uint256 public immutable override admitEpochSeconds;

    uint256 public override admittedRoot;
    uint256 public override revokedRoot;
    uint256 public lastAdmitPublish;

    mapping(uint256 => bool) public seenRevokedRoots;
    mapping(uint256 => bool) public seenAdmittedRoots;

    error NotPostman();
    error ZeroRoot();
    error AdmitEpoch();
    error AdmitRootReused();
    error RevokeRootReused();

    constructor(address postman_, uint256 admitEpochSeconds_) {
        require(postman_ != address(0), "postman");
        postman = postman_;
        admitEpochSeconds = admitEpochSeconds_;
    }

    function admittedRootIsCurrent(uint256 root) external view override returns (bool) {
        return root != 0 && root == admittedRoot;
    }

    function revokedRootIsCurrent(uint256 root) external view override returns (bool) {
        return root != 0 && root == revokedRoot;
    }

    function updateAdmittedRoot(uint256 newRoot) external override {
        if (msg.sender != postman) revert NotPostman();
        if (newRoot == 0) revert ZeroRoot();
        if (newRoot == admittedRoot) return;
        if (seenAdmittedRoots[newRoot]) revert AdmitRootReused();
        if (
            lastAdmitPublish != 0
                && block.timestamp < lastAdmitPublish + admitEpochSeconds
        ) {
            revert AdmitEpoch();
        }
        seenAdmittedRoots[newRoot] = true;
        lastAdmitPublish = block.timestamp;
        admittedRoot = newRoot;
        emit AdmittedRootUpdated(newRoot);
    }

    function updateRevokedRoot(uint256 newRoot) external override {
        if (msg.sender != postman) revert NotPostman();
        if (newRoot == 0) revert ZeroRoot();
        if (seenRevokedRoots[newRoot]) revert RevokeRootReused();
        uint256 prev = revokedRoot;
        seenRevokedRoots[newRoot] = true;
        revokedRoot = newRoot;
        emit RevokedRootUpdated(prev, newRoot);
    }
}

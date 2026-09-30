// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title NullifierSet
/// @notice Burns spent nullifier hashes (PROTOCOL §8.3).
contract NullifierSet {
    address public immutable operator;
    mapping(uint256 => bool) public used;

    error NullifierAlreadyUsed(uint256 nullifierHash);
    error NullifierZero();
    error NotOperator();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_) {
        operator = operator_;
    }

    function burn(uint256 nullifierHash) external onlyOperator {
        if (nullifierHash == 0) revert NullifierZero();
        if (used[nullifierHash]) revert NullifierAlreadyUsed(nullifierHash);
        used[nullifierHash] = true;
    }

    function isUsed(uint256 nullifierHash) external view returns (bool) {
        return used[nullifierHash];
    }
}

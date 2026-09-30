// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IHasher2
/// @notice Binary Poseidon for note / split trees. Production: `PoseidonHasher2`.
interface IHasher2 {
    function hash2(uint256 left, uint256 right) external pure returns (uint256);
}

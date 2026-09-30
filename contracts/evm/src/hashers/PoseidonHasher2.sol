// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

import {IHasher2} from "../interfaces/IHasher2.sol";

/// @title PoseidonHasher2
/// @notice Binary Poseidon (circomlib / poseidon-solidity T3) for note + split trees.
contract PoseidonHasher2 is IHasher2 {
    function hash2(uint256 left, uint256 right) external pure override returns (uint256) {
        return PoseidonT3.hash([left, right]);
    }
}

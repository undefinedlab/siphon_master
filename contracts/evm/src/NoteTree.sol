// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHasher2} from "./interfaces/IHasher2.sol";

/// @title NoteTree
/// @notice Depth-32 incremental Merkle tree of note commitments + historical root set.
/// @dev `knownRoots` is **unbounded** — every root ever inserted or recognized stays valid
///      for spend proofs. `ROOT_HISTORY` is only a fixed-length event log ring, not eviction.
contract NoteTree {
    uint256 public constant DEPTH = 32;
    /// @dev Ring buffer length for `rootHistory` audit log — does NOT expire `knownRoots`.
    uint256 public constant ROOT_HISTORY = 100;

    IHasher2 public immutable hasher;
    address public immutable operator;

    uint256 public leafCount;
    uint256 public currentRoot;
    uint256[DEPTH] public filledSubtrees;
    uint256[DEPTH] public zeros;

    mapping(uint256 => bool) public knownRoots;
    uint256[ROOT_HISTORY] public rootHistory;
    uint256 public rootHistoryIndex;

    /// @notice Emitted on every leaf insert so off-chain indexers can rebuild the tree
    ///         without decoding spend calldata (Phase B state-leaf visibility).
    /// @dev Reveals nothing new: deposit commitments are already in `Deposited` and spend
    ///      output commitments are already public limbs in `spend` calldata. `label`,
    ///      `precommitment`, and amounts are NOT exposed here.
    event CommitmentInserted(uint256 indexed leafIndex, uint256 commitment, uint256 newRoot);

    error ZeroCommitment();
    error ZeroRoot();
    error TreeFull();
    error NotOperator();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IHasher2 hasher_, address operator_) {
        hasher = hasher_;
        operator = operator_;
        uint256 z = 0;
        for (uint256 i = 0; i < DEPTH; i++) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = hasher_.hash2(z, z);
        }
        currentRoot = z;
        _remember(z);
    }

    function rootExists(uint256 root) public view returns (bool) {
        return knownRoots[root];
    }

    /// @dev Recognize a historical state root without inserting (fixture seed / migration).
    function recognizeRoot(uint256 root) external onlyOperator {
        if (root == 0) revert ZeroRoot();
        _remember(root);
    }

    function insert(uint256 commitment) external onlyOperator returns (uint256 newRoot) {
        if (commitment == 0) revert ZeroCommitment();
        if (leafCount >= (1 << DEPTH)) revert TreeFull();

        uint256 currentIndex = leafCount;
        uint256 currentLevelHash = commitment;

        for (uint256 i = 0; i < DEPTH; i++) {
            if (currentIndex % 2 == 0) {
                filledSubtrees[i] = currentLevelHash;
                currentLevelHash = hasher.hash2(currentLevelHash, zeros[i]);
            } else {
                currentLevelHash = hasher.hash2(filledSubtrees[i], currentLevelHash);
            }
            currentIndex >>= 1;
        }

        currentRoot = currentLevelHash;
        emit CommitmentInserted(leafCount, commitment, currentRoot);
        leafCount += 1;
        _remember(currentRoot);
        return currentRoot;
    }

    function _remember(uint256 root) internal {
        if (knownRoots[root]) return;
        knownRoots[root] = true;
        rootHistory[rootHistoryIndex] = root;
        rootHistoryIndex = (rootHistoryIndex + 1) % ROOT_HISTORY;
    }
}

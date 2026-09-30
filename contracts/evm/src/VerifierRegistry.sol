// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISiphonVerifier} from "./interfaces/ISiphonVerifier.sol";
import {IVerifierRegistry} from "./interfaces/IVerifierRegistry.sol";

/// @title VerifierRegistry
/// @notice Register-only programVersion → verifier map with governance timelock (OMEGA GF-H3).
/// @dev When `minDelay == 0`, `registerVerifier` may run immediately (tests / bootstrap).
///      When `minDelay > 0`, governance must `proposeVerifier` then wait before `registerVerifier`.
contract VerifierRegistry is IVerifierRegistry {
    address public immutable override governance;
    uint256 public immutable minDelay;

    mapping(uint256 version => address) public override verifiers;
    mapping(uint256 version => bytes32) public override programHashes;

    struct Proposal {
        address verifier;
        bytes32 programHash;
        uint64 readyAt;
        bool exists;
    }

    mapping(uint256 version => Proposal) public proposals;

    error NotGovernance();
    error VerifierExists();
    error ZeroVerifier();
    error UnknownVersion();
    error VerifierNoCode();
    error ProgramHashMismatch();
    error TimelockActive();
    error NoMatchingProposal();
    error ProposalExists();
    error NoProposal();

    event VerifierProposed(
        uint256 indexed version, address verifier, bytes32 programHash, uint64 readyAt
    );
    event ProposalCancelled(uint256 indexed version);

    constructor(address governance_, uint256 minDelay_) {
        require(governance_ != address(0), "gov");
        governance = governance_;
        minDelay = minDelay_;
    }

    function proposeVerifier(uint256 version, address verifier, bytes32 programHash)
        external
        override
    {
        if (msg.sender != governance) revert NotGovernance();
        if (verifier == address(0)) revert ZeroVerifier();
        if (verifier.code.length == 0) revert VerifierNoCode();
        if (programHash != keccak256(verifier.code)) revert ProgramHashMismatch();
        if (verifiers[version] != address(0)) revert VerifierExists();
        if (proposals[version].exists) revert ProposalExists();

        uint64 readyAt = uint64(block.timestamp + minDelay);
        proposals[version] =
            Proposal({verifier: verifier, programHash: programHash, readyAt: readyAt, exists: true});
        emit VerifierProposed(version, verifier, programHash, readyAt);
    }

    /// @notice Cancel a pending verifier proposal (OMEGA C-2 escape hatch).
    function cancelProposal(uint256 version) external {
        if (msg.sender != governance) revert NotGovernance();
        if (!proposals[version].exists) revert NoProposal();
        delete proposals[version];
        emit ProposalCancelled(version);
    }

    function registerVerifier(uint256 version, address verifier, bytes32 programHash)
        external
        override
    {
        if (msg.sender != governance) revert NotGovernance();
        if (verifier == address(0)) revert ZeroVerifier();
        if (verifier.code.length == 0) revert VerifierNoCode();
        if (programHash != keccak256(verifier.code)) revert ProgramHashMismatch();
        if (verifiers[version] != address(0)) revert VerifierExists();

        if (minDelay > 0) {
            Proposal memory p = proposals[version];
            if (!p.exists || p.verifier != verifier || p.programHash != programHash) {
                revert NoMatchingProposal();
            }
            if (block.timestamp < p.readyAt) revert TimelockActive();
            delete proposals[version];
        }

        verifiers[version] = verifier;
        programHashes[version] = programHash;
        emit VerifierRegistered(version, verifier, programHash);
    }

    function verifySpend(
        uint256 version,
        uint256[25] calldata publicInputs,
        uint256[8] calldata proof
    ) external view override returns (bool) {
        address v = verifiers[version];
        if (v == address(0)) revert UnknownVersion();
        return ISiphonVerifier(v).verifySpend(publicInputs, proof);
    }
}

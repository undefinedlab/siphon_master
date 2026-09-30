// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISiphonVerifier} from "./interfaces/ISiphonVerifier.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {PublicInputs} from "./libraries/PublicInputs.sol";

/// @title SpendActionGroth16Router
/// @notice Routes spend proofs to per-action Circom Groth16 verifiers (PROTOCOL §4.6).
/// @dev Replaces the dev-only equality wrap for production programVersion 2.
contract SpendActionGroth16Router is ISiphonVerifier {
    uint256 public constant ACTION_WITHDRAW = 0;
    uint256 public constant ACTION_MERGE = 1;
    uint256 public constant ACTION_SWAP = 2;
    uint256 public constant ACTION_SPLIT = 3;
    uint256 public constant ACTION_RAGEQUIT = 4;

    IGroth16Verifier public immutable withdraw1;
    IGroth16Verifier public immutable withdraw2;
    IGroth16Verifier public immutable withdraw3;
    IGroth16Verifier public immutable withdraw4;
    IGroth16Verifier public immutable withdraw5;
    IGroth16Verifier public immutable withdraw6;
    IGroth16Verifier public immutable merge2;
    IGroth16Verifier public immutable merge3;
    IGroth16Verifier public immutable merge4;
    IGroth16Verifier public immutable merge5;
    IGroth16Verifier public immutable merge6;
    IGroth16Verifier public immutable swap;
    IGroth16Verifier public immutable split;
    IGroth16Verifier public immutable ragequit;

    error UnknownSpendCircuit();

    constructor(
        IGroth16Verifier withdraw1_,
        IGroth16Verifier withdraw2_,
        IGroth16Verifier withdraw3_,
        IGroth16Verifier withdraw4_,
        IGroth16Verifier withdraw5_,
        IGroth16Verifier withdraw6_,
        IGroth16Verifier merge2_,
        IGroth16Verifier merge3_,
        IGroth16Verifier merge4_,
        IGroth16Verifier merge5_,
        IGroth16Verifier merge6_,
        IGroth16Verifier swap_,
        IGroth16Verifier split_,
        IGroth16Verifier ragequit_
    ) {
        withdraw1 = withdraw1_;
        withdraw2 = withdraw2_;
        withdraw3 = withdraw3_;
        withdraw4 = withdraw4_;
        withdraw5 = withdraw5_;
        withdraw6 = withdraw6_;
        merge2 = merge2_;
        merge3 = merge3_;
        merge4 = merge4_;
        merge5 = merge5_;
        merge6 = merge6_;
        swap = swap_;
        split = split_;
        ragequit = ragequit_;
    }

    function verifySpend(
        uint256[25] calldata publicInputs,
        uint256[8] calldata proof
    ) external view override returns (bool) {
        IGroth16Verifier verifier = _verifierFor(
            PublicInputs.action(publicInputs),
            PublicInputs.inputCount(publicInputs)
        );
        return verifier.verifyProof(
            [proof[0], proof[1]],
            [[proof[2], proof[3]], [proof[4], proof[5]]],
            [proof[6], proof[7]],
            publicInputs
        );
    }

    function _verifierFor(uint256 action, uint256 inputCount)
        internal
        view
        returns (IGroth16Verifier)
    {
        if (action == ACTION_WITHDRAW) {
            if (inputCount == 1) return withdraw1;
            if (inputCount == 2) return withdraw2;
            if (inputCount == 3) return withdraw3;
            if (inputCount == 4) return withdraw4;
            if (inputCount == 5) return withdraw5;
            if (inputCount == 6) return withdraw6;
        } else if (action == ACTION_MERGE) {
            if (inputCount == 2) return merge2;
            if (inputCount == 3) return merge3;
            if (inputCount == 4) return merge4;
            if (inputCount == 5) return merge5;
            if (inputCount == 6) return merge6;
        } else if (action == ACTION_SWAP && inputCount == 1) {
            return swap;
        } else if (action == ACTION_SPLIT && inputCount == 1) {
            return split;
        } else if (action == ACTION_RAGEQUIT && inputCount == 1) {
            return ragequit;
        }
        revert UnknownSpendCircuit();
    }
}

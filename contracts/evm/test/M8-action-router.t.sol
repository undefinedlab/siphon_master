// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {SpendActionGroth16Router} from "../src/SpendActionGroth16Router.sol";
import {ActionRouterDeploy} from "../script/ActionRouterDeploy.sol";

library ActionFixturePaths {
    string internal constant TV = "../fixtures/zkv2/test-vectors/";
}

/// @notice Production router uses real action verifiers (equality wrap removed).
contract Groth16ActionRouterTest is Test {
    using stdJson for string;

    SpendActionGroth16Router internal router;

    function setUp() public {
        PoseidonLink.etch();
        router = ActionRouterDeploy.deploy();
    }

    function _loadActionProof(string memory base)
        internal
        view
        returns (uint256[25] memory pi, uint256[8] memory proof)
    {
        string memory fx = string.concat(base, "-action-proof.json");
        string memory raw = vm.readFile(string.concat(ActionFixturePaths.TV, fx));
        string[] memory limbs = raw.readStringArray(".expectedPublic");
        require(limbs.length == 25, "PUBLIC_WIDTH");
        for (uint256 i = 0; i < 25; i++) {
            pi[i] = vm.parseUint(limbs[i]);
        }
        string[] memory proofLimbs = raw.readStringArray(".proof");
        require(proofLimbs.length == 8, "PROOF_WIDTH");
        for (uint256 j = 0; j < 8; j++) {
            proof[j] = vm.parseUint(proofLimbs[j]);
        }
    }

    function test_routerRejectsUnprovenRagequit() public view {
        uint256[25] memory pi;
        uint256[8] memory proof;
        pi[0] = PublicInputs.ACTION_RAGEQUIT;
        pi[1] = 1;
        assertFalse(router.verifySpend(pi, proof));
    }

    function test_ragequitRevokedRealActionProof() public view {
        (uint256[25] memory pi, uint256[8] memory proof) =
            _loadActionProof("ragequit-revoked-witness-ok");
        assertEq(pi[0], PublicInputs.ACTION_RAGEQUIT);
        assertTrue(router.verifySpend(pi, proof));
    }

    function test_withdrawW3RealActionProof() public view {
        (uint256[25] memory pi, uint256[8] memory proof) = _loadActionProof("withdraw-w3-ok");
        assertEq(pi[0], PublicInputs.ACTION_WITHDRAW);
        assertTrue(router.verifySpend(pi, proof));
    }

    function test_tamperedPublicFails() public view {
        (uint256[25] memory pi, uint256[8] memory proof) = _loadActionProof("withdraw-w3-ok");
        pi[5] = pi[5] + 1;
        assertFalse(router.verifySpend(pi, proof));
    }
}

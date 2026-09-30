// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {SpendActionGroth16Router} from "../src/SpendActionGroth16Router.sol";
import {ActionRouterDeploy} from "./ActionRouterDeploy.sol";

/// @notice Standalone action Groth16 verifier deploy (v1 `deployVerifier.ts` analogue).
///         Deploys W1–W6, M2–M6, swap, split, ragequit + SpendActionGroth16Router.
contract DeployActionVerifiers is Script {
    function run() external returns (ActionRouterDeploy.VerifierBundle memory bundle) {
        vm.startBroadcast();
        bundle = ActionRouterDeploy.deployVerifiers();
        SpendActionGroth16Router router = ActionRouterDeploy.deployRouterFrom(bundle);
        vm.stopBroadcast();

        bundle.router = address(router);

        console2.log("SpendActionGroth16Router", bundle.router);
        console2.log("SpendWithdrawVerifier1", bundle.withdraw1);
        console2.log("SpendWithdrawVerifier6", bundle.withdraw6);
        console2.log("SpendMergeVerifier2", bundle.merge2);
        console2.log("SpendMergeVerifier6", bundle.merge6);
        console2.log("SpendSwapVerifier", bundle.swap);
        console2.log("SpendSplitVerifier", bundle.split);
        console2.log("SpendRagequitVerifier", bundle.ragequit);
    }
}

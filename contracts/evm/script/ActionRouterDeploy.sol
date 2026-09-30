// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SpendActionGroth16Router} from "../src/SpendActionGroth16Router.sol";
import {IGroth16Verifier} from "../src/interfaces/IGroth16Verifier.sol";

import {SpendWithdrawVerifier1} from "../src/verifiers/SpendWithdrawVerifier1.sol";
import {SpendWithdrawVerifier2} from "../src/verifiers/SpendWithdrawVerifier2.sol";
import {SpendWithdrawVerifier3} from "../src/verifiers/SpendWithdrawVerifier3.sol";
import {SpendWithdrawVerifier4} from "../src/verifiers/SpendWithdrawVerifier4.sol";
import {SpendWithdrawVerifier5} from "../src/verifiers/SpendWithdrawVerifier5.sol";
import {SpendWithdrawVerifier6} from "../src/verifiers/SpendWithdrawVerifier6.sol";
import {SpendMergeVerifier2} from "../src/verifiers/SpendMergeVerifier2.sol";
import {SpendMergeVerifier3} from "../src/verifiers/SpendMergeVerifier3.sol";
import {SpendMergeVerifier4} from "../src/verifiers/SpendMergeVerifier4.sol";
import {SpendMergeVerifier5} from "../src/verifiers/SpendMergeVerifier5.sol";
import {SpendMergeVerifier6} from "../src/verifiers/SpendMergeVerifier6.sol";
import {SpendSwapVerifier} from "../src/verifiers/SpendSwapVerifier.sol";
import {SpendSplitVerifier} from "../src/verifiers/SpendSplitVerifier.sol";
import {SpendRagequitVerifier} from "../src/verifiers/SpendRagequitVerifier.sol";

/// @dev Shared deploy for SpendActionGroth16Router (14 action VKs). Used by forge scripts + tests.
library ActionRouterDeploy {
    struct VerifierBundle {
        address withdraw1;
        address withdraw2;
        address withdraw3;
        address withdraw4;
        address withdraw5;
        address withdraw6;
        address merge2;
        address merge3;
        address merge4;
        address merge5;
        address merge6;
        address swap;
        address split;
        address ragequit;
        address router;
    }

    function deployVerifiers() internal returns (VerifierBundle memory b) {
        b.withdraw1 = address(new SpendWithdrawVerifier1());
        b.withdraw2 = address(new SpendWithdrawVerifier2());
        b.withdraw3 = address(new SpendWithdrawVerifier3());
        b.withdraw4 = address(new SpendWithdrawVerifier4());
        b.withdraw5 = address(new SpendWithdrawVerifier5());
        b.withdraw6 = address(new SpendWithdrawVerifier6());
        b.merge2 = address(new SpendMergeVerifier2());
        b.merge3 = address(new SpendMergeVerifier3());
        b.merge4 = address(new SpendMergeVerifier4());
        b.merge5 = address(new SpendMergeVerifier5());
        b.merge6 = address(new SpendMergeVerifier6());
        b.swap = address(new SpendSwapVerifier());
        b.split = address(new SpendSplitVerifier());
        b.ragequit = address(new SpendRagequitVerifier());
    }

    function deployRouterFrom(VerifierBundle memory b) internal returns (SpendActionGroth16Router) {
        return new SpendActionGroth16Router(
            IGroth16Verifier(b.withdraw1),
            IGroth16Verifier(b.withdraw2),
            IGroth16Verifier(b.withdraw3),
            IGroth16Verifier(b.withdraw4),
            IGroth16Verifier(b.withdraw5),
            IGroth16Verifier(b.withdraw6),
            IGroth16Verifier(b.merge2),
            IGroth16Verifier(b.merge3),
            IGroth16Verifier(b.merge4),
            IGroth16Verifier(b.merge5),
            IGroth16Verifier(b.merge6),
            IGroth16Verifier(b.swap),
            IGroth16Verifier(b.split),
            IGroth16Verifier(b.ragequit)
        );
    }

    function deploy() internal returns (SpendActionGroth16Router) {
        VerifierBundle memory b = deployVerifiers();
        return deployRouterFrom(b);
    }
}

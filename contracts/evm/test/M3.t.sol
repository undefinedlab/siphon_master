// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";
import {ComplianceHub} from "../src/ComplianceHub.sol";
import {DigestSpendVerifier} from "./helpers/VaultTestDeploy.sol";

/// @dev Paths relative to `evm/` (Foundry project root).
library FixturePaths {
    string internal constant TV = "../fixtures/zkv2/test-vectors/";
}

contract VerifierRegistryTest is Test {
    VerifierRegistry internal registry;
    DigestSpendVerifier internal digest;
    address internal gov;

    function setUp() public {
        gov = makeAddr("gov");
        registry = new VerifierRegistry(gov, 0);
        digest = new DigestSpendVerifier();
    }

    function test_registerOnce() public {
        bytes32 elf = keccak256(address(digest).code);
        vm.prank(gov);
        registry.registerVerifier(2, address(digest), elf);
        assertEq(registry.verifiers(2), address(digest));
        assertEq(registry.programHashes(2), elf);
    }

    function test_registerOnly_rejectsSwap() public {
        bytes32 elf = keccak256(address(digest).code);
        vm.prank(gov);
        registry.registerVerifier(2, address(digest), elf);

        DigestSpendVerifier other = new DigestSpendVerifier();
        vm.prank(gov);
        vm.expectRevert(VerifierRegistry.VerifierExists.selector);
        registry.registerVerifier(2, address(other), keccak256(address(other).code));
    }

    function test_onlyGovernance() public {
        vm.expectRevert(VerifierRegistry.NotGovernance.selector);
        registry.registerVerifier(2, address(digest), bytes32(uint256(1)));
    }

    function test_verifySpend_routesToDigestVerifier() public {
        vm.prank(gov);
        registry.registerVerifier(2, address(digest), keccak256(address(digest).code));

        uint256[25] memory pi;
        pi[0] = 0;
        pi[1] = 1;
        pi[8] = 0;
        pi[16] = 2;
        digest.setExpectedPublics(pi);

        uint256[8] memory proof;
        proof[0] = 1;
        assertTrue(registry.verifySpend(2, pi, proof));

        pi[5] = 999;
        assertFalse(registry.verifySpend(2, pi, proof));
    }

    function test_digestVerifier_settersAreOwnerOnly() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(DigestSpendVerifier.NotOwner.selector);
        digest.setExpectedDigest(bytes32(uint256(1)));
    }
}

contract ComplianceHubTest is Test {
    ComplianceHub internal hub;
    address internal postman;

    function setUp() public {
        postman = makeAddr("postman");
        hub = new ComplianceHub(postman, 0);
    }

    function test_updateRoots() public {
        vm.prank(postman);
        hub.updateAdmittedRoot(111);
        vm.prank(postman);
        hub.updateRevokedRoot(222);
        assertTrue(hub.admittedRootIsCurrent(111));
        assertTrue(hub.revokedRootIsCurrent(222));
        assertFalse(hub.admittedRootIsCurrent(0));
        assertFalse(hub.revokedRootIsCurrent(111));
    }

    function test_admitRootReused() public {
        vm.startPrank(postman);
        hub.updateAdmittedRoot(111);
        hub.updateAdmittedRoot(222);
        vm.expectRevert(ComplianceHub.AdmitRootReused.selector);
        hub.updateAdmittedRoot(111);
        vm.stopPrank();
    }

    function test_onlyPostman() public {
        vm.expectRevert(ComplianceHub.NotPostman.selector);
        hub.updateAdmittedRoot(1);
    }
}

/// @notice GF-H2: guest expectedPublic limbs bind 1:1 to Vault calldata layout.
contract PublicInputsMatchGuestCommit is Test {
    using stdJson for string;

    function _loadExpectedPublic(string memory fixture)
        internal
        view
        returns (uint256[25] memory pi)
    {
        string memory path = string.concat(FixturePaths.TV, fixture);
        string memory raw = vm.readFile(path);
        string[] memory limbs = raw.readStringArray(".expectedPublic");
        require(limbs.length == 25, "PUBLIC_WIDTH");
        for (uint256 i = 0; i < 25; i++) {
            pi[i] = vm.parseUint(limbs[i]);
        }
    }

    function test_publicEncodingWidth() public view {
        string memory raw = vm.readFile(string.concat(FixturePaths.TV, "public-encoding.json"));
        assertEq(raw.readUint(".PUBLIC_WIDTH"), 25);
        string[] memory names = raw.readStringArray(".fieldNames");
        assertEq(names.length, 25);
        assertEq(names[8], "outLabel");
        assertEq(names[16], "programVersion");
    }

    function test_withdrawW3_guestCommit_kernelPre() public {
        uint256[25] memory pi = _loadExpectedPublic("withdraw-w3-ok.json");
        assertEq(pi[0], 0); // WITHDRAW
        assertEq(pi[1], 3);
        assertEq(pi[8], 0); // outLabel MUST be 0
        assertEq(pi[16], PublicInputs.PROGRAM_VERSION);
        PublicInputs.checkKernelPre(pi, PublicInputs.PROGRAM_VERSION);
    }

    function test_mergeM2_guestCommit_kernelPre() public {
        uint256[25] memory pi = _loadExpectedPublic("merge-m2-ok.json");
        assertEq(pi[0], 1);
        assertEq(pi[5], 0); // MERGE primary public = 0
        assertEq(pi[6], 0);
        assertEq(pi[8], 0);
        assertTrue(pi[7] != 0); // outCommitment binds amount privately
        PublicInputs.checkKernelPre(pi, PublicInputs.PROGRAM_VERSION);
    }

    function test_mergeM6_guestCommit_kernelPre() public {
        uint256[25] memory pi = _loadExpectedPublic("merge-m6-ok.json");
        assertEq(pi[0], 1);
        assertEq(pi[1], 6);
        assertEq(pi[5], 0);
        assertEq(pi[8], 0);
        PublicInputs.checkKernelPre(pi, PublicInputs.PROGRAM_VERSION);
    }

    function test_ragequitPending_guestCommit_kernelPre() public {
        uint256[25] memory pi = _loadExpectedPublic("ragequit-pending-witness-ok.json");
        assertEq(pi[0], 4);
        assertEq(pi[1], 1);
        assertEq(pi[8], 0);
        assertEq(pi[15], 0); // payee on mux 17
        assertTrue(pi[17] != 0);
        assertTrue(pi[3] != 0); // current admittedRoot (3.4)
        assertTrue(pi[4] != 0); // current revokedRoot
        PublicInputs.checkKernelPre(pi, PublicInputs.PROGRAM_VERSION);
    }

    function test_digestVerifier_bindsGuestDigest() public {
        DigestSpendVerifier digest = new DigestSpendVerifier();
        uint256[25] memory pi = _loadExpectedPublic("withdraw-w3-ok.json");
        digest.setExpectedPublics(pi);

        uint256[8] memory proof;
        proof[0] = 42;
        assertTrue(digest.verifySpend(pi, proof));

        // Tamper primaryValue — digest must fail (calldata ≠ guest commit).
        pi[5] = pi[5] + 1;
        assertFalse(digest.verifySpend(pi, proof));
    }

    function test_kernelPre_rejectsPublicOutLabel() public {
        uint256[25] memory pi = _loadExpectedPublic("withdraw-w3-ok.json");
        pi[8] = 1;
        vm.expectRevert(PublicInputs.OutLabelMustBeZero.selector);
        this._check(pi);
    }

    function test_kernelPre_rejectsMergePrimary() public {
        uint256[25] memory pi = _loadExpectedPublic("merge-m2-ok.json");
        pi[5] = 750;
        vm.expectRevert(PublicInputs.MergePrimaryMustBeZero.selector);
        this._check(pi);
    }

    function test_kernelPre_rejectsUnusedMux() public {
        uint256[25] memory pi = _loadExpectedPublic("withdraw-w3-ok.json");
        pi[18] = 1; // [17] is assetId (D1); unused starts at 18
        vm.expectRevert(PublicInputs.UnusedMuxNonZero.selector);
        this._check(pi);
    }

    function _check(uint256[25] calldata pi) external pure {
        PublicInputs.checkKernelPre(pi, PublicInputs.PROGRAM_VERSION);
    }
}

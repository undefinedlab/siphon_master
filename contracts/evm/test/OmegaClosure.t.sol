// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";
import {ComplianceHub} from "../src/ComplianceHub.sol";
import {VaultKernel} from "../src/VaultKernel.sol";
import {IVaultKernel} from "../src/interfaces/IVaultKernel.sol";
import {NoteTree} from "../src/NoteTree.sol";
import {Erc20AssetAdapter} from "../src/adapters/Erc20AssetAdapter.sol";
import {PayeeCodecEvm} from "../src/payees/PayeeCodecEvm.sol";
import {PoseidonHasher2} from "../src/hashers/PoseidonHasher2.sol";
import {
    VaultTestDeploy,
    DigestSpendVerifier,
    SpendVerifyTrap
} from "./helpers/VaultTestDeploy.sol";

/// @notice DELTA regressions for OMEGA F-1 / F-2 / F-5 / F-6 (contracts-v2).
contract OmegaClosureTest is Test {
    /// @dev foundry.toml links Poseidon to canonical addresses that do not exist in the
    /// test EVM; etch it before anything hashes. No-op once present.
    function setUp() public {
        PoseidonLink.etch();
    }

    // F-1: first root stays valid after ROOT_HISTORY ring wraps.
    function test_noteTree_knownRootsIndefinite() public {
        PoseidonHasher2 hasher = new PoseidonHasher2();
        NoteTree tree = new NoteTree(hasher, address(this));
        uint256 firstRoot = tree.currentRoot();
        assertTrue(tree.rootExists(firstRoot));

        for (uint256 i = 1; i <= 105; i++) {
            tree.insert(10_000 + i);
        }
        assertTrue(tree.rootExists(firstRoot), "F-1: bootstrap root must stay spendable");
    }

    function test_noteTree_middleRootSurvivesRingWrap() public {
        PoseidonHasher2 hasher = new PoseidonHasher2();
        NoteTree tree = new NoteTree(hasher, address(this));
        uint256 midRoot;
        for (uint256 i = 1; i <= 50; i++) {
            tree.insert(20_000 + i);
            if (i == 50) midRoot = tree.currentRoot();
        }
        for (uint256 i = 51; i <= 105; i++) {
            tree.insert(20_000 + i);
        }
        assertTrue(tree.rootExists(midRoot), "F-1: mid-history root must stay spendable");
    }

    // Phase B: every insert emits CommitmentInserted so the indexer can rebuild the state
    // tree without decoding spend calldata. leafIndex is 0-based (pre-increment position).
    event CommitmentInserted(uint256 indexed leafIndex, uint256 commitment, uint256 newRoot);

    function test_noteTree_insertEmitsCommitmentInserted() public {
        PoseidonHasher2 hasher = new PoseidonHasher2();
        NoteTree tree = new NoteTree(hasher, address(this));

        // First real leaf is index 0.
        vm.expectEmit(true, false, false, false);
        emit CommitmentInserted(0, 111, 0); // topic (leafIndex) checked; data not asserted here
        tree.insert(111);
        assertEq(tree.leafCount(), 1);

        // Second leaf is index 1, and the emitted newRoot must equal the resulting currentRoot.
        vm.recordLogs();
        uint256 returnedRoot = tree.insert(222);
        assertEq(tree.leafCount(), 2);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == CommitmentInserted.selector) {
                assertEq(uint256(logs[i].topics[1]), 1, "leafIndex must be 1 (0-based)");
                (uint256 commitment, uint256 newRoot) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(commitment, 222, "commitment must match inserted leaf");
                assertEq(newRoot, returnedRoot, "emitted newRoot must equal currentRoot");
                found = true;
            }
        }
        assertTrue(found, "CommitmentInserted must be emitted on insert");
    }

    function test_admitRootForwardPublish_stillAllowed() public {
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 0);
        vm.startPrank(postman);
        hub.updateAdmittedRoot(111);
        hub.updateAdmittedRoot(222);
        hub.updateAdmittedRoot(333);
        vm.stopPrank();
        assertEq(hub.admittedRoot(), 333);
        assertTrue(hub.seenAdmittedRoots(111));
        assertTrue(hub.seenAdmittedRoots(222));
    }

    // F-2: postman cannot republish a previously used admittedRoot (rollback).
    function test_admitRootReused_blocksRollback() public {
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 0);
        vm.startPrank(postman);
        hub.updateAdmittedRoot(111);
        hub.updateAdmittedRoot(222);
        vm.expectRevert(ComplianceHub.AdmitRootReused.selector);
        hub.updateAdmittedRoot(111);
        vm.stopPrank();
        assertEq(hub.admittedRoot(), 222);
    }

    function test_admitRootReused_allowsNoOpSameCurrent() public {
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 0);
        vm.startPrank(postman);
        hub.updateAdmittedRoot(111);
        hub.updateAdmittedRoot(111);
        assertEq(hub.admittedRoot(), 111);
        vm.stopPrank();
    }

    // F-5: kernel pre-check rejects bad limbs before verifySpend (digest trap would accept).
    function test_spendKernelPreBeforeVerify_rejectsOutLabel() public {
        VaultTestDeploy.Stack memory s;
        DigestSpendVerifier digest;
        (s, digest) = VaultTestDeploy.deployWithDigestVerifier(makeAddr("gov"), makeAddr("postman"));
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_WITHDRAW;
        pi[1] = 1;
        pi[8] = 1; // OutLabelMustBeZero
        pi[16] = PublicInputs.PROGRAM_VERSION;
        digest.setExpectedPublics(pi);

        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(PublicInputs.OutLabelMustBeZero.selector);
        s.vault.spend(pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()}));
    }

    /// @dev OMEGA F-5 PoC: if verify ran before pre-check, SpendVerifyTrap would revert VerifyCalled.
    function test_spendKernelPreBeforeVerify_trapNeverInvoked() public {
        VaultTestDeploy.Stack memory s;
        (s,) = VaultTestDeploy.deployWithVerifyTrap(makeAddr("gov"), makeAddr("postman"));
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_MERGE;
        pi[1] = 2;
        pi[5] = 1; // MergePrimaryMustBeZero
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(PublicInputs.MergePrimaryMustBeZero.selector);
        s.vault.spend(pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()}));
    }

    // F-6: pause all actions in one governance tx.
    function test_setAllActionsPaused_blocksEveryAction() public {
        VaultTestDeploy.Stack memory s;
        DigestSpendVerifier digest;
        address gov = makeAddr("gov");
        (s, digest) = VaultTestDeploy.deployWithDigestVerifier(gov, makeAddr("postman"));
        vm.prank(gov);
        s.vault.setAllActionsPaused(true);
        for (uint256 a = 0; a <= PublicInputs.ACTION_RAGEQUIT; a++) {
            assertTrue(s.vault.actionPaused(a));
        }

        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_WITHDRAW;
        pi[1] = 1;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        digest.setExpectedPublics(pi);
        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(
            abi.encodeWithSelector(VaultKernel.ActionPaused.selector, PublicInputs.ACTION_WITHDRAW)
        );
        s.vault.spend(pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()}));

        vm.prank(gov);
        s.vault.setAllActionsPaused(false);
        assertFalse(s.vault.actionPaused(PublicInputs.ACTION_WITHDRAW));
    }

    function test_setAllActionsPaused_blocksRagequitAction() public {
        VaultTestDeploy.Stack memory s;
        DigestSpendVerifier digest;
        (s, digest) = VaultTestDeploy.deployWithDigestVerifier(makeAddr("gov"), makeAddr("postman"));
        vm.prank(makeAddr("gov"));
        s.vault.setAllActionsPaused(true);
        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_RAGEQUIT;
        pi[1] = 1;
        pi[8] = 0;
        pi[15] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        pi[17] = 1;
        digest.setExpectedPublics(pi);
        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(
            abi.encodeWithSelector(VaultKernel.ActionPaused.selector, PublicInputs.ACTION_RAGEQUIT)
        );
        s.vault.spend(pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()}));
    }

    function test_setAllActionsPaused_onlyGovernance() public {
        VaultTestDeploy.Stack memory s = VaultTestDeploy.deployReal(makeAddr("gov"), makeAddr("postman"));
        vm.expectRevert(VaultKernel.NotGovernance.selector);
        s.vault.setAllActionsPaused(true);
    }

    // --- OMEGA re-audit DELTA (C-1 / C-2 / C-3 / C-4) ---

    /// @dev OMEGA C-1 PoC: first deposit permanently blocks migration seed.
    function test_C1_depositBeforeSeed_blocksMigrationForever() public {
        VaultTestDeploy.Stack memory s = VaultTestDeploy.deployReal(makeAddr("gov"), makeAddr("postman"));
        address depositor = makeAddr("depositor");
        _fundAndDeposit(s, depositor, 1000, 4242, 123);
        assertEq(s.vault.notes().leafCount(), 1);

        vm.prank(makeAddr("gov"));
        vm.expectRevert(VaultKernel.SeedingLocked.selector);
        s.vault.seedHistoricalRoot(999);
        assertFalse(s.vault.historicalSeedingLocked());
    }

    function test_C1_depositsPausedBootstrap_allowsSeedBeforeGoLive() public {
        VaultTestDeploy.Stack memory s = VaultTestDeploy.deployReal(makeAddr("gov"), makeAddr("postman"));
        address gov = makeAddr("gov");
        vm.prank(gov);
        s.vault.setDepositsPaused(true);

        vm.prank(gov);
        s.vault.seedHistoricalRoot(777);
        assertTrue(s.vault.historicalSeedingLocked());

        vm.prank(gov);
        s.vault.setDepositsPaused(false);

        _fundAndDeposit(s, makeAddr("depositor"), 500, 1111, 222);
        assertEq(s.vault.notes().leafCount(), 1);
        assertTrue(s.vault.notes().rootExists(777));
    }

    function test_C2_cancelProposal_allowsVerifierReplacement() public {
        address gov = makeAddr("gov");
        VerifierRegistry registry = new VerifierRegistry(gov, 300);
        DigestSpendVerifier wrong = new DigestSpendVerifier();
        DigestSpendVerifier right = new DigestSpendVerifier();
        bytes32 wrongHash = keccak256(address(wrong).code);
        bytes32 rightHash = keccak256(address(right).code);

        vm.startPrank(gov);
        registry.proposeVerifier(2, address(wrong), wrongHash);
        vm.expectRevert(VerifierRegistry.ProposalExists.selector);
        registry.proposeVerifier(2, address(right), rightHash);
        registry.cancelProposal(2);
        registry.proposeVerifier(2, address(right), rightHash);
        vm.stopPrank();

        (address verifier,,, bool exists) = registry.proposals(2);
        assertTrue(exists);
        assertEq(verifier, address(right));
    }

    function test_C3_zeroPayee_revertsBeforeAssetPush() public {
        VaultTestDeploy.Stack memory s;
        DigestSpendVerifier digest;
        (s, digest) = VaultTestDeploy.deployWithDigestVerifier(makeAddr("gov"), makeAddr("postman"));
        s.assetToken.mint(address(s.vault), 1_000_000 ether);

        PayeeCodecEvm payees = PayeeCodecEvm(address(s.vault.payees()));
        bytes memory raw = hex"0000000000000000000000000000000000000000";
        uint256 payeeId = payees.payeeId(raw);

        vm.startPrank(makeAddr("postman"));
        s.hub.updateAdmittedRoot(111);
        s.hub.updateRevokedRoot(222);
        vm.stopPrank();

        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_WITHDRAW;
        pi[1] = 1;
        pi[2] = s.vault.notes().currentRoot();
        pi[3] = 111;
        pi[4] = 222;
        pi[5] = 1000;
        pi[8] = 0;
        pi[9] = 1;
        pi[15] = payeeId;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        digest.setExpectedPublics(pi);

        uint256[8] memory proof;
        proof[0] = 1;

        vm.expectRevert(VaultKernel.ZeroPayee.selector);
        s.vault.spend(
            pi,
            proof,
            IVaultKernel.SpendExtra({rawPayee: raw, splitCommitments: _zeroSplit()})
        );
        assertEq(s.assets.pushCount(), 0);
    }

    function test_C4_fullFreeze_requiresDepositsAndActionsPause() public {
        VaultTestDeploy.Stack memory s = VaultTestDeploy.deployReal(makeAddr("gov"), makeAddr("postman"));
        address gov = makeAddr("gov");

        vm.prank(gov);
        s.vault.setAllActionsPaused(true);
        assertFalse(s.vault.depositsPaused());

        _fundAndDeposit(s, makeAddr("depositor"), 100, 9999, 1);
        assertEq(s.assets.pullCount(), 1);

        vm.prank(gov);
        s.vault.setDepositsPaused(true);
        vm.prank(makeAddr("depositor2"));
        vm.expectRevert(VaultKernel.DepositsArePaused.selector);
        s.vault.deposit(address(s.assetToken), 100, 8888, 1);
    }

    function _fundAndDeposit(
        VaultTestDeploy.Stack memory s,
        address depositor,
        uint256 amount,
        uint256 salt,
        uint256 pre
    ) internal {
        s.assetToken.mint(depositor, amount);
        vm.startPrank(depositor);
        s.assetToken.approve(address(s.assets), amount);
        s.vault.deposit(address(s.assetToken), amount, salt, pre);
        vm.stopPrank();
    }

    function _zeroSplit() internal pure returns (uint256[8] memory split) {}
}

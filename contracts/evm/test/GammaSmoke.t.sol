// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {CommitmentLib} from "../src/libraries/CommitmentLib.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";
import {ComplianceHub} from "../src/ComplianceHub.sol";
import {IComplianceHub} from "../src/interfaces/IComplianceHub.sol";
import {VaultKernel} from "../src/VaultKernel.sol";
import {IVaultKernel} from "../src/interfaces/IVaultKernel.sol";
import {SpendActionGroth16Router} from "../src/SpendActionGroth16Router.sol";
import {Erc20SettlementAdapter} from "../src/adapters/Erc20SettlementAdapter.sol";
import {FreeMintErc20} from "../src/tokens/FreeMintErc20.sol";
import {PayeeCodecEvm} from "../src/payees/PayeeCodecEvm.sol";
import {ActionRouterDeploy} from "../script/ActionRouterDeploy.sol";
import {VaultTestDeploy, DigestSpendVerifier} from "./helpers/VaultTestDeploy.sol";

/// @notice GAMMA smoke assertions — not the DELTA exhaustive suite.
contract GammaSmokeTest is Test {
    /// @dev foundry.toml links Poseidon to canonical addresses that do not exist in the
    /// test EVM; etch it before anything hashes. No-op once present.
    function setUp() public {
        PoseidonLink.etch();
    }

    using stdJson for string;

    function test_payeeCodecEvm_matchesFixture() public {
        string memory raw = vm.readFile("../fixtures/zkv2/test-vectors/chain-profile-evm.json");
        uint256 expected = vm.parseUint(raw.readString(".payeeId"));
        PayeeCodecEvm codec = new PayeeCodecEvm();
        bytes memory payee = hex"00000000000000000000000000000000000000b2";
        assertEq(codec.payeeId(payee), expected);
    }

    function test_programHashMismatch_reverts() public {
        address gov = makeAddr("gov");
        VerifierRegistry registry = new VerifierRegistry(gov, 0);
        SpendActionGroth16Router router = ActionRouterDeploy.deploy();
        vm.prank(gov);
        vm.expectRevert(VerifierRegistry.ProgramHashMismatch.selector);
        registry.registerVerifier(2, address(router), keccak256("wrong"));
    }

    function test_registerRequiresTimelockWhenDelaySet() public {
        address gov = makeAddr("gov");
        VerifierRegistry registry = new VerifierRegistry(gov, 300);
        SpendActionGroth16Router router = ActionRouterDeploy.deploy();
        bytes32 ph = keccak256(address(router).code);

        vm.prank(gov);
        vm.expectRevert(VerifierRegistry.NoMatchingProposal.selector);
        registry.registerVerifier(2, address(router), ph);

        vm.prank(gov);
        registry.proposeVerifier(2, address(router), ph);

        vm.prank(gov);
        vm.expectRevert(VerifierRegistry.TimelockActive.selector);
        registry.registerVerifier(2, address(router), ph);

        vm.warp(block.timestamp + 300);
        vm.prank(gov);
        registry.registerVerifier(2, address(router), ph);
        assertEq(registry.verifiers(2), address(router));
    }

    function test_revokeEmitsRootOnlyEvent() public {
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 0);
        vm.prank(postman);
        vm.expectEmit(true, true, true, true);
        emit IComplianceHub.RevokedRootUpdated(0, 111);
        hub.updateRevokedRoot(111);
        assertTrue(hub.revokedRootIsCurrent(111));
    }

    function test_revokeRootCannotBeReused() public {
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 0);
        vm.startPrank(postman);
        hub.updateRevokedRoot(111);
        hub.updateRevokedRoot(222);
        vm.expectRevert(ComplianceHub.RevokeRootReused.selector);
        hub.updateRevokedRoot(111);
        vm.stopPrank();
    }

    function test_admitEpochEnforced() public {
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 300);
        vm.prank(postman);
        hub.updateAdmittedRoot(111);
        vm.prank(postman);
        vm.expectRevert(ComplianceHub.AdmitEpoch.selector);
        hub.updateAdmittedRoot(222);
        vm.warp(block.timestamp + 300);
        vm.prank(postman);
        hub.updateAdmittedRoot(222);
        assertTrue(hub.admittedRootIsCurrent(222));
    }

    /// @notice Empty ASP / SMT root matches zkv2 fixtures (aspv2 PublishComplianceRoots bootstrap).
    function test_emptyAspRoot_matchesFixture() public {
        string memory raw = vm.readFile("../fixtures/zkv2/test-vectors/asp/empty-root.json");
        uint256 emptyRoot = vm.parseUint(raw.readString(".emptyRoot"));
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 0);
        vm.startPrank(postman);
        hub.updateAdmittedRoot(emptyRoot);
        hub.updateRevokedRoot(emptyRoot);
        vm.stopPrank();
        assertTrue(hub.admittedRootIsCurrent(emptyRoot));
        assertTrue(hub.revokedRootIsCurrent(emptyRoot));
    }

    /// @notice Salted label matches zkv2 / aspv2 deposit-ok vector (CommitmentLib).
    function test_depositOk_mintLabelSalted() public {
        string memory raw = vm.readFile("../fixtures/zkv2/test-vectors/deposit-ok.json");
        uint256 scope = vm.parseUint(raw.readString(".vaultScopeId"));
        uint256 nonce = vm.parseUint(raw.readString(".depositNonce"));
        uint256 salt = vm.parseUint(raw.readString(".userSalt"));
        uint256 expected = vm.parseUint(raw.readString(".expectedLabel"));
        assertEq(CommitmentLib.mintLabelSalted(scope, nonce, salt), expected);
    }

    function test_admitRootReused_revertsRollback() public {
        address postman = makeAddr("postman");
        ComplianceHub hub = new ComplianceHub(postman, 0);
        vm.startPrank(postman);
        hub.updateAdmittedRoot(111);
        hub.updateAdmittedRoot(222);
        vm.expectRevert(ComplianceHub.AdmitRootReused.selector);
        hub.updateAdmittedRoot(111);
        vm.stopPrank();
    }

    function test_setAllActionsPaused_blocksSpend() public {
        (VaultTestDeploy.Stack memory stack, DigestSpendVerifier digest, address gov) =
            _deployVaultWithDigest();
        vm.prank(gov);
        stack.vault.setAllActionsPaused(true);
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
        stack.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
    }

    function test_depositBindsMeasuredAmountNotClaimed() public {
        VaultTestDeploy.Stack memory stack = _deployVault();
        uint256 salt = 4242;
        uint256 pre = 99;
        uint256 amount = 1000;
        uint256 assetId = CommitmentLib.assetIdFromToken(address(stack.assetToken));
        uint256 expectedC = CommitmentLib.commitmentHash(
            amount, CommitmentLib.mintLabelSalted(stack.vault.vaultScopeId(), 1, salt), assetId, pre
        );
        address depositor = makeAddr("depositor");
        stack.assetToken.mint(depositor, amount);
        vm.startPrank(depositor);
        stack.assetToken.approve(address(stack.assets), amount);
        uint256 c = stack.vault.deposit(address(stack.assetToken), amount, salt, pre);
        vm.stopPrank();
        assertEq(c, expectedC);
        assertEq(stack.assets.lastAmount(), amount);
    }

    function test_depositsPauseLeavesSpendPath() public {
        (VaultTestDeploy.Stack memory stack, address gov) = _deployVaultWithGov();
        vm.prank(gov);
        stack.vault.setDepositsPaused(true);
        vm.prank(makeAddr("depositor"));
        vm.expectRevert(VaultKernel.DepositsArePaused.selector);
        stack.vault.deposit(address(stack.assetToken), 1000, 4242, 1);
        assertTrue(stack.vault.depositsPaused());
    }

    function test_actionPause_blocksTarget_beforeProof() public {
        (VaultTestDeploy.Stack memory stack, DigestSpendVerifier digest, address gov) =
            _deployVaultWithDigest();
        vm.prank(gov);
        stack.vault.setActionPaused(PublicInputs.ACTION_SWAP, true);
        assertTrue(stack.vault.actionPaused(PublicInputs.ACTION_SWAP));
        assertFalse(stack.vault.actionPaused(PublicInputs.ACTION_WITHDRAW));

        uint256[25] memory pi;
        pi[0] = PublicInputs.ACTION_SWAP;
        pi[1] = 1;
        pi[8] = 0;
        pi[16] = PublicInputs.PROGRAM_VERSION;
        digest.setExpectedPublics(pi);

        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(
            abi.encodeWithSelector(VaultKernel.ActionPaused.selector, PublicInputs.ACTION_SWAP)
        );
        stack.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
    }

    function test_actionPause_unpausedReachesProofFailed() public {
        (VaultTestDeploy.Stack memory stack, DigestSpendVerifier digest,) = _deployVaultWithDigest();
        // Digest set for zeros; we send different limbs → verify returns false → ProofFailed.
        uint256[25] memory expected;
        expected[0] = PublicInputs.ACTION_WITHDRAW;
        expected[1] = 1;
        expected[16] = PublicInputs.PROGRAM_VERSION;
        digest.setExpectedPublics(expected);

        uint256[25] memory pi = expected;
        pi[5] = 999; // digest drift
        uint256[8] memory proof;
        proof[0] = 1;
        vm.expectRevert(VaultKernel.ProofFailed.selector);
        stack.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
    }

    function test_setActionPaused_onlyGovernance() public {
        VaultTestDeploy.Stack memory stack = _deployVault();
        vm.expectRevert(VaultKernel.NotGovernance.selector);
        stack.vault.setActionPaused(PublicInputs.ACTION_MERGE, true);
    }

    function test_setActionPaused_rejectsBadAction() public {
        (VaultTestDeploy.Stack memory stack, address gov) = _deployVaultWithGov();
        vm.prank(gov);
        vm.expectRevert(VaultKernel.BadAction.selector);
        stack.vault.setActionPaused(5, true);
    }

    function test_seedHistoricalRootLocksAfterFirstSeed() public {
        (VaultTestDeploy.Stack memory stack, address gov) = _deployVaultWithGov();
        vm.prank(gov);
        stack.vault.seedHistoricalRoot(123);
        vm.prank(gov);
        vm.expectRevert(VaultKernel.SeedingLocked.selector);
        stack.vault.seedHistoricalRoot(456);
    }

    function test_swapSlippage_revertsBeforeDestInsert() public {
        vm.chainId(84532);
        address gov = makeAddr("gov");
        address postman = makeAddr("postman");
        VaultTestDeploy.Stack memory stack = VaultTestDeploy.deployReal(gov, postman);

        string memory raw = vm.readFile("../fixtures/zkv2/test-vectors/swap-ok.json");
        uint256 adm = vm.parseUint(raw.readString(".admittedRoot"));
        uint256 rev = vm.parseUint(raw.readString(".revokedRoot"));
        uint256 sr = vm.parseUint(raw.readString(".stateRoot"));
        vm.prank(postman);
        stack.hub.updateAdmittedRoot(adm);
        vm.prank(postman);
        stack.hub.updateRevokedRoot(rev);
        vm.prank(gov);
        stack.vault.seedHistoricalRoot(sr);

        string memory actionFx =
            vm.readFile("../fixtures/zkv2/test-vectors/swap-ok-action-proof.json");
        string[] memory limbs = actionFx.readStringArray(".expectedPublic");
        uint256[25] memory pi;
        for (uint256 i = 0; i < 25; i++) {
            pi[i] = vm.parseUint(limbs[i]);
        }
        string[] memory proofLimbs = actionFx.readStringArray(".proof");
        uint256[8] memory proof;
        for (uint256 j = 0; j < 8; j++) {
            proof[j] = vm.parseUint(proofLimbs[j]);
        }

        // Allowlist fixture assets but leave settlement dst inventory empty → Slippage.
        address src = address(uint160(pi[23]));
        address dst = address(uint160(pi[18]));
        FreeMintErc20 impl = new FreeMintErc20();
        vm.etch(src, address(impl).code);
        vm.etch(dst, address(impl).code);
        vm.prank(gov);
        stack.vault.setTokenAllowed(src, true);
        vm.prank(gov);
        stack.vault.setTokenAllowed(dst, true);
        vm.prank(gov);
        stack.vault.approveAssetOutbound(src, address(stack.settlement), type(uint256).max);
        FreeMintErc20(src).mint(address(stack.vault), pi[5]);

        uint256 leavesBefore = stack.vault.notes().leafCount();
        vm.expectRevert(Erc20SettlementAdapter.Slippage.selector);
        stack.vault.spend(
            pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()})
        );
        assertEq(stack.vault.notes().leafCount(), leavesBefore);
    }

    function _deployVault() internal returns (VaultTestDeploy.Stack memory stack) {
        stack = VaultTestDeploy.deployReal(makeAddr("gov"), makeAddr("postman"));
    }

    function _deployVaultWithGov()
        internal
        returns (VaultTestDeploy.Stack memory stack, address gov)
    {
        gov = makeAddr("gov");
        stack = VaultTestDeploy.deployReal(gov, makeAddr("postman"));
    }

    function _deployVaultWithDigest()
        internal
        returns (VaultTestDeploy.Stack memory stack, DigestSpendVerifier digest, address gov)
    {
        gov = makeAddr("gov");
        (stack, digest) = VaultTestDeploy.deployWithDigestVerifier(gov, makeAddr("postman"));
    }

    function _zeroSplit() internal pure returns (uint256[8] memory s) {}
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {VaultKernel} from "../src/VaultKernel.sol";
import {IVaultKernel} from "../src/interfaces/IVaultKernel.sol";
import {FreeMintErc20} from "../src/tokens/FreeMintErc20.sol";
import {VaultTestDeploy} from "./helpers/VaultTestDeploy.sol";

library FixturePaths {
    string internal constant TV = "../fixtures/zkv2/test-vectors/";
}

/// @notice M4 vault spend path with real action Groth16 proofs (SpendActionGroth16Router).
contract VaultKernelM4Test is Test {
    using stdJson for string;

    VaultTestDeploy.Stack internal s;

    address internal gov;
    address internal postman;
    address internal relayer;

    function setUp() public {
        vm.chainId(84532);
        gov = makeAddr("gov");
        postman = makeAddr("postman");
        relayer = makeAddr("relayer");
        s = VaultTestDeploy.deployReal(gov, postman);
    }

    function _loadAction(string memory base)
        internal
        view
        returns (uint256[25] memory pi, uint256[8] memory proof)
    {
        string memory raw =
            vm.readFile(string.concat(FixturePaths.TV, base, "-action-proof.json"));
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

    function _loadRoot(string memory fixture, string memory key)
        internal
        view
        returns (uint256)
    {
        string memory raw = vm.readFile(string.concat(FixturePaths.TV, fixture));
        return vm.parseUint(raw.readString(key));
    }

    function _seedCompliance(string memory fixture) internal {
        uint256 adm = _loadRoot(fixture, ".admittedRoot");
        uint256 rev = _loadRoot(fixture, ".revokedRoot");
        vm.prank(postman);
        s.hub.updateAdmittedRoot(adm);
        vm.prank(postman);
        s.hub.updateRevokedRoot(rev);
    }

    function _seedState(string memory fixture) internal {
        uint256 sr = _loadRoot(fixture, ".stateRoot");
        vm.prank(gov);
        s.vault.seedHistoricalRoot(sr);
    }

    function _emptyExtra() internal pure returns (IVaultKernel.SpendExtra memory extra) {}

    /// @dev Fixture assetIds are fixed field addresses — etch FreeMint + allowlist + fund vault.
    function _preparePushToken(uint256 assetId, uint256 fundAmount) internal returns (address token) {
        token = address(uint160(assetId));
        FreeMintErc20 impl = new FreeMintErc20();
        vm.etch(token, address(impl).code);
        vm.prank(gov);
        s.vault.setTokenAllowed(token, true);
        vm.prank(gov);
        s.vault.approveAssetOutbound(token, address(s.assets), type(uint256).max);
        FreeMintErc20(token).mint(address(s.vault), fundAmount);
    }

    function test_withdrawW3_relayerSpend() public {
        string memory fx = "withdraw-w3-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("withdraw-w3-ok");
        _seedCompliance(fx);
        _seedState(fx);
        _preparePushToken(pi[17], type(uint128).max);

        string memory raw = vm.readFile(string.concat(FixturePaths.TV, fx));
        bytes memory payee = vm.parseBytes(string.concat("0x", raw.readString(".rawPayeeHex")));
        require(payee.length == 20, "payee-len");

        IVaultKernel.SpendExtra memory extra;
        extra.rawPayee = payee;

        uint256 beforeLeaves = s.vault.notes().leafCount();

        vm.prank(relayer);
        s.vault.spend(pi, proof, extra);

        assertEq(s.assets.pushCount(), 1);
        assertEq(s.assets.lastAmount(), pi[5]);
        assertEq(s.assets.lastTo(), address(bytes20(payee)));
        assertEq(s.vault.notes().leafCount(), beforeLeaves + 1);
        assertTrue(s.vault.nullifiers().isUsed(pi[9]));
        assertTrue(s.vault.nullifiers().isUsed(pi[10]));
        assertTrue(s.vault.nullifiers().isUsed(pi[11]));
    }

    function test_withdraw_rejectsStaleAdmittedRoot() public {
        string memory fx = "withdraw-w3-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("withdraw-w3-ok");
        _seedState(fx);
        vm.prank(postman);
        s.hub.updateAdmittedRoot(pi[3]);
        vm.prank(postman);
        s.hub.updateRevokedRoot(pi[4]);
        vm.prank(postman);
        s.hub.updateAdmittedRoot(pi[3] + 1);

        bytes memory payee = hex"00000000000000000000000000000000000000b2";
        IVaultKernel.SpendExtra memory extra;
        extra.rawPayee = payee;

        vm.prank(relayer);
        vm.expectRevert(VaultKernel.StaleAdmittedRoot.selector);
        s.vault.spend(pi, proof, extra);
    }

    function test_mergeM2_insertsOutCommitmentOnly() public {
        string memory fx = "merge-m2-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("merge-m2-ok");
        _seedCompliance(fx);
        _seedState(fx);

        uint256 before = s.vault.notes().leafCount();
        vm.prank(relayer);
        s.vault.spend(pi, proof, _emptyExtra());

        assertEq(s.assets.pushCount(), 0);
        assertEq(s.vault.notes().leafCount(), before + 1);
        assertEq(pi[5], 0);
        assertEq(pi[8], 0);
    }

    function test_merge_rejectsReplayNullifier() public {
        string memory fx = "merge-m2-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("merge-m2-ok");
        _seedCompliance(fx);
        _seedState(fx);

        vm.prank(relayer);
        s.vault.spend(pi, proof, _emptyExtra());

        vm.prank(relayer);
        vm.expectRevert();
        s.vault.spend(pi, proof, _emptyExtra());
    }

    function test_ragequitPending_paysNoInsert() public {
        string memory fx = "ragequit-pending-witness-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("ragequit-pending-witness-ok");
        _seedCompliance(fx);
        _seedState(fx);
        _preparePushToken(pi[18], type(uint128).max);

        string memory raw = vm.readFile(string.concat(FixturePaths.TV, fx));
        bytes memory payee = vm.parseBytes(string.concat("0x", raw.readString(".rawPayeeHex")));

        uint256 before = s.vault.notes().leafCount();
        IVaultKernel.SpendExtra memory extra;
        extra.rawPayee = payee;

        vm.prank(relayer);
        s.vault.spend(pi, proof, extra);

        assertEq(s.assets.pushCount(), 1);
        assertEq(s.assets.lastAmount(), pi[5]);
        assertEq(s.vault.notes().leafCount(), before);
        assertTrue(s.vault.nullifiers().isUsed(pi[9]));
    }

    function test_ragequit_rejectsWrongPayee() public {
        string memory fx = "ragequit-pending-witness-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("ragequit-pending-witness-ok");
        _seedCompliance(fx);
        _seedState(fx);

        bytes memory payee = hex"00000000000000000000000000000000000000b3";
        IVaultKernel.SpendExtra memory extra;
        extra.rawPayee = payee;

        vm.prank(relayer);
        vm.expectRevert(VaultKernel.PayeeMismatch.selector);
        s.vault.spend(pi, proof, extra);
    }

    function test_unknownStateRoot_reverts() public {
        string memory fx = "merge-m2-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("merge-m2-ok");
        _seedCompliance(fx);

        vm.prank(relayer);
        vm.expectRevert(VaultKernel.UnknownStateRoot.selector);
        s.vault.spend(pi, proof, _emptyExtra());
    }

    function test_proofTamper_reverts() public {
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("merge-m2-ok");
        string memory fx = "merge-m2-ok.json";
        _seedCompliance(fx);
        _seedState(fx);
        pi[7] = pi[7] + 1;

        vm.prank(relayer);
        vm.expectRevert(VaultKernel.ProofFailed.selector);
        s.vault.spend(pi, proof, _emptyExtra());
    }
}

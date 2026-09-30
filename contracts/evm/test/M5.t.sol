// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {VaultKernel} from "../src/VaultKernel.sol";
import {IVaultKernel} from "../src/interfaces/IVaultKernel.sol";
import {FreeMintErc20} from "../src/tokens/FreeMintErc20.sol";
import {VaultTestDeploy} from "./helpers/VaultTestDeploy.sol";

library FixturePathsM5 {
    string internal constant TV = "../fixtures/zkv2/test-vectors/";
}

/// @notice M5 swap/split finalize with real action Groth16 proofs (SpendActionGroth16Router).
contract VaultKernelM5Test is Test {
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
            vm.readFile(string.concat(FixturePathsM5.TV, base, "-action-proof.json"));
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
        string memory raw = vm.readFile(string.concat(FixturePathsM5.TV, fixture));
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

    function test_swapOk_insertsDestAndChange() public {
        string memory fx = "swap-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("swap-ok");
        _seedCompliance(fx);
        _seedState(fx);

        // Fixture assetIds are field encodings of fixed addresses — etch FreeMint ERC-20s there.
        address src = address(uint160(pi[23]));
        address dst = address(uint160(pi[18]));
        FreeMintErc20 impl = new FreeMintErc20();
        vm.etch(src, address(impl).code);
        vm.etch(dst, address(impl).code);
        vm.prank(gov);
        s.vault.setTokenAllowed(src, true);
        vm.prank(gov);
        s.vault.setTokenAllowed(dst, true);
        vm.prank(gov);
        s.vault.approveAssetOutbound(src, address(s.settlement), type(uint256).max);
        FreeMintErc20(src).mint(address(s.vault), pi[5]); // amountIn
        FreeMintErc20(dst).mint(address(s.settlement), type(uint128).max);

        // Settlement pays ~amountIn; fixture minOut < amountIn → protocol surplus accrues.
        // Note mint is gov-only (OVERLORD F-2) — swap inserts change + user dest only.
        uint256 rootBefore = s.vault.stateRoot();
        uint256 leavesBefore = s.vault.notes().leafCount();
        vm.prank(relayer);
        s.vault.spend(pi, proof, IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: _zeroSplit()}));

        assertTrue(s.vault.stateRoot() != rootBefore, "state root updated");
        assertEq(s.vault.notes().leafCount(), leavesBefore + 2);
        assertTrue(pi[7] != 0, "change commitment");
        assertTrue(pi[22] != 0, "dest commitment");
        assertEq(s.settlement.fillCount(), 1);
        assertEq(s.settlement.lastMinOut(), pi[20]);
        assertTrue(s.vault.protocolClaimable(dst) > 0, "surplus accrued");
    }

    function test_splitOk_insertsActiveSlicesOnly() public {
        string memory fx = "split-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("split-ok");
        _seedCompliance(fx);
        _seedState(fx);

        uint256[8] memory slices = _fixtureSliceCommitments();
        assertEq(pi[17], _merkleRoot8(slices), "proof binds Poseidon splitRoot");

        uint256 rootBefore = s.vault.stateRoot();
        uint256 leavesBefore = s.vault.notes().leafCount();
        vm.prank(relayer);
        s.vault.spend(
            pi,
            proof,
            IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: slices})
        );

        assertTrue(s.vault.stateRoot() != rootBefore, "state root updated");
        // Two non-zero slices in fixture
        assertEq(s.vault.notes().leafCount(), leavesBefore + 2);
        assertEq(pi[7], 0);
        assertEq(pi[15], 0);
    }

    function test_split_calldataMismatch_reverts() public {
        string memory fx = "split-ok.json";
        (uint256[25] memory pi, uint256[8] memory proof) = _loadAction("split-ok");
        _seedCompliance(fx);
        _seedState(fx);

        uint256[8] memory slices = _fixtureSliceCommitments();
        slices[1] = slices[1] + 1;

        vm.prank(relayer);
        vm.expectRevert(VaultKernel.SplitRootMismatch.selector);
        s.vault.spend(
            pi,
            proof,
            IVaultKernel.SpendExtra({rawPayee: "", splitCommitments: slices})
        );
    }

    function _fixtureSliceCommitments() internal view returns (uint256[8] memory slices) {
        string memory mismatch =
            vm.readFile(string.concat(FixturePathsM5.TV, "split-calldata-mismatch.json"));
        string[] memory commitments = mismatch.readStringArray(".sliceCommitments");
        for (uint256 i = 0; i < 8; i++) {
            slices[i] = vm.parseUint(commitments[i]);
        }
    }

    function _merkleRoot8(uint256[8] memory leaves) internal view returns (uint256) {
        uint256[4] memory l1;
        for (uint256 i = 0; i < 4; i++) {
            l1[i] = s.hasher.hash2(leaves[2 * i], leaves[2 * i + 1]);
        }
        uint256[2] memory l2;
        l2[0] = s.hasher.hash2(l1[0], l1[1]);
        l2[1] = s.hasher.hash2(l1[2], l1[3]);
        return s.hasher.hash2(l2[0], l2[1]);
    }

    function _zeroSplit() internal pure returns (uint256[8] memory split) {}
}

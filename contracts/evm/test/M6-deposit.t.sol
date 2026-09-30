// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {CommitmentLib} from "../src/libraries/CommitmentLib.sol";
import {VaultKernel} from "../src/VaultKernel.sol";
import {SimpleErc20} from "../src/tokens/SimpleErc20.sol";
import {VaultTestDeploy} from "./helpers/VaultTestDeploy.sol";

library DepositFixturePaths {
    string internal constant TV = "../fixtures/zkv2/test-vectors/";
}

contract VaultKernelDepositTest is Test {
    using stdJson for string;

    VaultTestDeploy.Stack internal s;

    address internal depositor = makeAddr("depositor");

    function setUp() public {
        vm.chainId(84532);
        s = VaultTestDeploy.deployReal(makeAddr("gov"), makeAddr("postman"));
    }

    function test_depositOk_matchesFixtureCommitment() public {
        string memory raw = vm.readFile(string.concat(DepositFixturePaths.TV, "deposit-ok.json"));
        uint256 amount = vm.parseUint(raw.readString(".measuredAmount"));
        uint256 userSalt = vm.parseUint(raw.readString(".userSalt"));
        uint256 nullifier = vm.parseUint(raw.readString(".nullifier"));
        uint256 secret = vm.parseUint(raw.readString(".secret"));
        uint256 assetId = CommitmentLib.assetIdFromToken(address(s.assetToken));

        uint256 pre = CommitmentLib.precommitment(nullifier, secret);
        uint256 expectedC = CommitmentLib.commitmentHash(
            amount,
            CommitmentLib.mintLabelSalted(s.vault.vaultScopeId(), 1, userSalt),
            assetId,
            pre
        );

        s.assetToken.mint(depositor, amount);
        vm.startPrank(depositor);
        s.assetToken.approve(address(s.assets), amount);
        uint256 c = s.vault.deposit(address(s.assetToken), amount, userSalt, pre);
        vm.stopPrank();

        assertEq(c, expectedC);
        assertEq(s.vault.depositNonce(), 1);
        assertEq(s.assets.lastFrom(), depositor);
        assertEq(s.assets.lastAmount(), amount);
        assertEq(s.assets.lastToken(), address(s.assetToken));
        assertTrue(s.vault.stateRoot() != 0);
    }

    function test_deposit_rejectsZeroSalt() public {
        vm.prank(depositor);
        vm.expectRevert(VaultKernel.ZeroUserSalt.selector);
        s.vault.deposit(address(s.assetToken), 1000, 0, 123);
    }

    function test_deposit_rejectsZeroAmount() public {
        vm.prank(depositor);
        vm.expectRevert(VaultKernel.ZeroDepositAmount.selector);
        s.vault.deposit(address(s.assetToken), 0, 4242, 123);
    }

    function test_deposit_rejectsUnallowedToken() public {
        SimpleErc20 other = new SimpleErc20("X", "X");
        vm.prank(depositor);
        vm.expectRevert(VaultKernel.TokenNotAllowed.selector);
        s.vault.deposit(address(other), 1000, 4242, 123);
    }
}

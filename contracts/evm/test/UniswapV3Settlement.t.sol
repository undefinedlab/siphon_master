// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoseidonLink} from "./helpers/PoseidonLink.sol";

import {UniswapV3SettlementAdapter} from "../src/adapters/UniswapV3SettlementAdapter.sol";
import {MockSwapRouter} from "../src/adapters/MockSwapRouter.sol";
import {SimpleErc20} from "../src/tokens/SimpleErc20.sol";

contract UniswapV3SettlementAdapterTest is Test {
    MockSwapRouter internal router;
    UniswapV3SettlementAdapter internal settlement;
    SimpleErc20 internal src;
    SimpleErc20 internal dst;
    address internal vault = makeAddr("vault");

    function setUp() public {
        PoseidonLink.etch();
        router = new MockSwapRouter();
        settlement = new UniswapV3SettlementAdapter(address(router));
        settlement.setVault(vault);
        src = new SimpleErc20("SRC", "SRC");
        dst = new SimpleErc20("DST", "DST");

        src.mint(vault, 1_000 ether);
        dst.mint(address(router), 1_000 ether);

        vm.startPrank(vault);
        src.approve(address(settlement), type(uint256).max);
        vm.stopPrank();
    }

    function test_fill_measuresDstBalanceDelta() public {
        uint256 before = dst.balanceOf(vault);
        vm.prank(vault);
        uint256 out = settlement.fill(0, address(src), address(dst), 3000, 100 ether, 100 ether);
        assertEq(out, 100 ether);
        assertEq(dst.balanceOf(vault) - before, 100 ether);
        assertEq(src.balanceOf(vault), 900 ether);
    }

    function test_fill_revertsIfNotVault() public {
        vm.expectRevert(UniswapV3SettlementAdapter.NotVault.selector);
        settlement.fill(0, address(src), address(dst), 3000, 1, 1);
    }

    function test_fill_revertsOnSlippage() public {
        // Drain router inventory so mock cannot pay minOut.
        uint256 bal = dst.balanceOf(address(router));
        // Steal via storage wipe of ERC20 balances (owner mint path already used).
        deal(address(dst), address(router), 0);
        assertEq(dst.balanceOf(address(router)), 0);
        assertEq(bal, 1_000 ether);
        vm.prank(vault);
        vm.expectRevert();
        settlement.fill(0, address(src), address(dst), 3000, 10 ether, 10 ether);
    }
}

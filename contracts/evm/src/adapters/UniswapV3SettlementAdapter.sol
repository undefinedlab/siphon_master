// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISettlementAdapter} from "../interfaces/ISettlementAdapter.sol";
import {SimpleErc20} from "../tokens/SimpleErc20.sol";

/// @dev Minimal SwapRouter02 exactInputSingle surface (Uniswap V3 periphery).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @title UniswapV3SettlementAdapter
/// @notice Production D1 settlement: vault src → Uniswap V3 → measured dst on vault.
/// @dev Never trust router-reported amountOut for note minting — kernel uses measured return.
contract UniswapV3SettlementAdapter is ISettlementAdapter {
    address public immutable swapRouter;
    address public immutable deployer;
    address public vault;

    error NotVault();
    error Slippage();
    error ZeroAddress();
    error BadFee();
    error NotDeployer();
    error SameAsset();

    constructor(address swapRouter_) {
        if (swapRouter_ == address(0)) revert ZeroAddress();
        swapRouter = swapRouter_;
        deployer = msg.sender;
    }

    /// @dev OVERLORD F-3: one-shot vault bind — only deployer (not permissionless).
    function setVault(address vault_) external {
        if (msg.sender != deployer) revert NotDeployer();
        require(vault == address(0), "vault-set");
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
    }

    /// @dev OVERLORD F-5: `pool` limb is reserved / unused — Uniswap V3 pool is selected by
    ///      (tokenIn, tokenOut, fee). Callers MUST still pass the circuit mux `pi[17]` for layout.
    function fill(
        uint256, /* pool — OVERLORD F-5: unused; fee + pair select the pool */
        address srcToken,
        address dstToken,
        uint256 fee,
        uint256 amountIn,
        uint256 minAmountOut
    ) external override returns (uint256 measuredOut) {
        if (srcToken == dstToken) revert SameAsset(); // belt-and-suspenders vs kernel SwapSameAsset
        if (msg.sender != vault) revert NotVault();
        if (srcToken == address(0) || dstToken == address(0)) revert ZeroAddress();
        if (fee == 0 || fee > type(uint24).max) revert BadFee();

        // Pull src from vault into this adapter, then approve router.
        require(SimpleErc20(srcToken).transferFrom(vault, address(this), amountIn), "src");
        require(SimpleErc20(srcToken).approve(swapRouter, amountIn), "approve");

        uint256 balBefore = SimpleErc20(dstToken).balanceOf(vault);
        ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: srcToken,
                tokenOut: dstToken,
                fee: uint24(fee),
                recipient: vault,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );
        measuredOut = SimpleErc20(dstToken).balanceOf(vault) - balBefore;
        if (measuredOut < minAmountOut) revert Slippage();

        // Clear dust allowance.
        SimpleErc20(srcToken).approve(swapRouter, 0);
    }
}

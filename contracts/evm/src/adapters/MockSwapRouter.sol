// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISettlementAdapter} from "../interfaces/ISettlementAdapter.sol";
import {SimpleErc20} from "../tokens/SimpleErc20.sol";

/// @title MockSwapRouter
/// @notice Foundry/testnet stand-in for Uniswap V3 SwapRouter02 exactInputSingle.
contract MockSwapRouter {
    /// @dev Pays `amountIn` of tokenOut from this contract's inventory to `recipient`.
    function exactInputSingle(
        ISwapRouter02Like.ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        require(
            SimpleErc20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn),
            "in"
        );
        amountOut = params.amountIn; // 1:1 mock
        require(amountOut >= params.amountOutMinimum, "slip");
        require(SimpleErc20(params.tokenOut).transfer(params.recipient, amountOut), "out");
    }
}

interface ISwapRouter02Like {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
}

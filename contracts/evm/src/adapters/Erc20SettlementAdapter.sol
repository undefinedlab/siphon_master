// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISettlementAdapter} from "../interfaces/ISettlementAdapter.sol";
import {SimpleErc20} from "../tokens/SimpleErc20.sol";

/// @title Erc20SettlementAdapter
/// @notice Measured dst-token payout for SWAP finalize (PROTOCOL §6.3). Uses adapter liquidity inventory.
/// @dev Production mainnet should use UniswapV3SettlementAdapter; this is the bootstrap path for Foundry.
contract Erc20SettlementAdapter is ISettlementAdapter {
    address public immutable deployer;
    address public vault;

    uint256 public fillCount;
    uint256 public lastAmountIn;
    uint256 public lastMinOut;
    address public lastSrc;
    address public lastDst;

    error NotVault();
    error Slippage();
    error NotDeployer();

    constructor() {
        deployer = msg.sender;
    }

    /// @dev OVERLORD F-3: one-shot vault bind — only deployer (not permissionless).
    function setVault(address vault_) external {
        if (msg.sender != deployer) revert NotDeployer();
        require(vault == address(0), "vault-set");
        vault = vault_;
    }

    /// @notice Fund swap liquidity for a dst token (governance or market maker).
    function fundLiquidity(address dstToken, uint256 amount) external {
        require(SimpleErc20(dstToken).transferFrom(msg.sender, address(this), amount), "fund");
    }

    function fill(
        uint256,
        address srcToken,
        address dstToken,
        uint256,
        uint256 amountIn,
        uint256 minAmountOut
    ) external override returns (uint256 measuredOut) {
        if (msg.sender != vault) revert NotVault();
        lastAmountIn = amountIn;
        lastMinOut = minAmountOut;
        lastSrc = srcToken;
        lastDst = dstToken;
        fillCount += 1;

        // Consume src from vault into adapter (optional sink for accounting tests).
        if (amountIn > 0 && srcToken != address(0)) {
            uint256 srcBal = SimpleErc20(srcToken).balanceOf(vault);
            uint256 take = amountIn <= srcBal ? amountIn : srcBal;
            if (take > 0) {
                require(SimpleErc20(srcToken).transferFrom(vault, address(this), take), "src");
            }
        }

        uint256 balBefore = SimpleErc20(dstToken).balanceOf(vault);
        uint256 available = SimpleErc20(dstToken).balanceOf(address(this));
        uint256 payout = amountIn <= available ? amountIn : available;
        if (payout > 0) {
            require(SimpleErc20(dstToken).transfer(vault, payout), "payout");
        }
        measuredOut = SimpleErc20(dstToken).balanceOf(vault) - balBefore;
        if (measuredOut < minAmountOut) revert Slippage();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISettlementAdapter
/// @notice AMM fill bound to SWAP mux 17–23 (PROTOCOL §6.3 / §8.4 / D1).
interface ISettlementAdapter {
    /// @dev Execute the pool swap. MUST measure token deltas (FoT-safe) and revert on slippage.
    /// @return measuredOut Actual `dstToken` received by the vault.
    function fill(
        uint256 pool,
        address srcToken,
        address dstToken,
        uint256 fee,
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 measuredOut);
}

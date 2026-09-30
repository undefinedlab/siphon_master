// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAssetAdapter
/// @notice Multi-token measured pull/push (PROTOCOL §2.7 / §8.4 / D1).
interface IAssetAdapter {
    /// @dev Pull up to `amount` of `token` from `from`. Return the **received** delta (never the claimed amount).
    function pull(address token, address from, uint256 amount) external returns (uint256 received);

    function push(address token, address to, uint256 amount) external;

    function balance(address token) external view returns (uint256);
}

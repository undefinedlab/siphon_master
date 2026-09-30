// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPayeeCodec
/// @notice Maps raw payee bytes → public payeeId field (PROTOCOL §1.2 / evm-v1).
interface IPayeeCodec {
    function payeeId(bytes calldata rawPayee) external view returns (uint256);
}

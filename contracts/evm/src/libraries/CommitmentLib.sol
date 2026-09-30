// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";

/// @title CommitmentLib
/// @notice Poseidon note hashing — matches `spend-core` / circom (PROTOCOL §2.2 / D1).
library CommitmentLib {
    uint256 internal constant DOMAIN_VAULT_SCOPE = 3;
    uint256 internal constant DOMAIN_CHAIN_EVM = 5;

    function precommitment(uint256 nullifier, uint256 secret) internal pure returns (uint256) {
        return PoseidonT3.hash([nullifier, secret]);
    }

    /// @dev D1: `Poseidon(Poseidon(amount, label, assetId), pre)`
    function commitmentHash(uint256 amount, uint256 label, uint256 assetId, uint256 pre)
        internal
        pure
        returns (uint256)
    {
        return PoseidonT3.hash([PoseidonT4.hash([amount, label, assetId]), pre]);
    }

    /// @dev `Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce)`
    function nonceStem(uint256 vaultScopeId, uint256 depositNonce) internal pure returns (uint256) {
        return PoseidonT4.hash([DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce]);
    }

    /// @dev Salted label mint — PROTOCOL §2.3.
    function mintLabelSalted(uint256 vaultScopeId, uint256 depositNonce, uint256 userSalt)
        internal
        pure
        returns (uint256)
    {
        return PoseidonT3.hash([nonceStem(vaultScopeId, depositNonce), userSalt]);
    }

    function vaultScopeIdEvm(uint256 chainId, uint256 vaultAddressField) internal pure returns (uint256) {
        return PoseidonT4.hash([DOMAIN_CHAIN_EVM, chainId, vaultAddressField]);
    }

    function assetIdFromToken(address token) internal pure returns (uint256) {
        return uint256(uint160(token));
    }

    function tokenFromAssetId(uint256 assetId) internal pure returns (address) {
        return address(uint160(assetId));
    }
}

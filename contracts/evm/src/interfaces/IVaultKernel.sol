// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVaultKernel
/// @notice Relayer-callable spend entry (PROTOCOL §8 / D1).
interface IVaultKernel {
    struct SpendExtra {
        /// @dev EVM: 20-byte address for WITHDRAW / RAGEQUIT / SWAP payee bind.
        bytes rawPayee;
        /// @dev SPLIT only — must equal guest slice commitments (§4.4).
        uint256[8] splitCommitments;
    }

    function programVersion() external view returns (uint256);

    function stateRoot() external view returns (uint256);

    function spend(
        uint256[25] calldata publicInputs,
        uint256[8] calldata proof,
        SpendExtra calldata extra
    ) external;

    /// @dev Multi-token deposit — PROTOCOL §2.7 / D1 (`userSalt` + secret precommitment only; no label calldata).
    ///      Note amount is the **measured** adapter delta; `assetId = uint160(token)`.
    function deposit(address token, uint256 amount, uint256 userSalt, uint256 precommitment)
        external
        returns (uint256 commitment);

    function depositNonce() external view returns (uint256);

    function vaultScopeId() external view returns (uint256);

    function depositsPaused() external view returns (bool);

    /// @dev GF-M2: true if governance paused this spend action id (0–4).
    function actionPaused(uint256 action) external view returns (bool);

    function isTokenAllowed(address token) external view returns (bool);
}

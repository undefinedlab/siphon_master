// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAssetAdapter} from "../interfaces/IAssetAdapter.sol";
import {SimpleErc20} from "../tokens/SimpleErc20.sol";

/// @title Erc20AssetAdapter
/// @notice Multi-token measured ERC-20 pull/push for VaultKernel (PROTOCOL D1). FoT-safe via balance delta.
contract Erc20AssetAdapter is IAssetAdapter {
    address public immutable deployer;
    address public vault;

    uint256 public pullCount;
    uint256 public pushCount;
    address public lastToken;
    address public lastFrom;
    address public lastTo;
    uint256 public lastAmount;

    error NotVault();
    error ZeroToken();
    error NotDeployer();

    event Pulled(address indexed token, address indexed from, uint256 received);
    event Pushed(address indexed token, address indexed to, uint256 amount);

    constructor() {
        deployer = msg.sender;
    }

    /// @dev OVERLORD F-3: one-shot vault bind — only deployer (not permissionless).
    function setVault(address vault_) external {
        if (msg.sender != deployer) revert NotDeployer();
        require(vault == address(0), "vault-set");
        vault = vault_;
    }

    function pull(address token, address from, uint256 amount)
        external
        override
        returns (uint256 received)
    {
        if (msg.sender != vault) revert NotVault();
        if (token == address(0)) revert ZeroToken();
        uint256 before = SimpleErc20(token).balanceOf(vault);
        require(SimpleErc20(token).transferFrom(from, vault, amount), "transferFrom");
        received = SimpleErc20(token).balanceOf(vault) - before;
        lastToken = token;
        lastFrom = from;
        lastAmount = received;
        pullCount += 1;
        emit Pulled(token, from, received);
    }

    function push(address token, address to, uint256 amount) external override {
        if (msg.sender != vault) revert NotVault();
        if (token == address(0)) revert ZeroToken();
        require(SimpleErc20(token).transferFrom(vault, to, amount), "transferFrom");
        lastToken = token;
        lastTo = to;
        lastAmount = amount;
        pushCount += 1;
        emit Pushed(token, to, amount);
    }

    function balance(address token) external view override returns (uint256) {
        return SimpleErc20(token).balanceOf(vault);
    }
}

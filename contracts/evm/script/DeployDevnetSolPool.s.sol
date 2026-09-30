// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SimpleErc20} from "../src/tokens/SimpleErc20.sol";

/// @dev Uniswap V3 factory (same address on Sepolia + many EVM chains).
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
}

/**
 * Devnet E2E: deploy Siphon tSOL (SimpleErc20 "SOL") and ensure a Uniswap V3 pool vs WETH.
 *
 *   forge script script/DeployDevnetSolPool.s.sol:DeployDevnetSolPool \
 *     --rpc-url $ETH_SEPOLIA_RPC --broadcast -vvvv
 *
 * Env:
 *   WETH           — default Sepolia WETH
 *   EXISTING_SOL   — optional; skip deploy and only ensure pool
 *   POOL_FEE       — default 3000 (0.3%)
 *   SQRT_PRICE_X96 — default 2^96 (1:1) for initialize when pool is new
 */
contract DeployDevnetSolPool is Script {
    address constant UNISWAP_V3_FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    address constant SEPOLIA_WETH_DEFAULT = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    function run() external {
        address weth = vm.envOr("WETH", SEPOLIA_WETH_DEFAULT);
        address existing = vm.envOr("EXISTING_SOL", address(0));
        uint24 fee = uint24(vm.envOr("POOL_FEE", uint256(3000)));
        // 1:1 price in Uniswap V3 sqrtPriceX96 units
        uint160 sqrtPriceX96 = uint160(vm.envOr("SQRT_PRICE_X96", uint256(1 << 96)));

        vm.startBroadcast();

        address sol = existing;
        if (sol == address(0)) {
            SimpleErc20 token = new SimpleErc20("Siphon Devnet SOL", "SOL");
            sol = address(token);
            console2.log("Deployed tSOL", sol);
            // Seed liquidity inventory for the deployer (optional manual addLiquidity later).
            token.mint(msg.sender, 1_000_000 ether);
        } else {
            console2.log("Using existing tSOL", sol);
        }

        IUniswapV3Factory factory = IUniswapV3Factory(UNISWAP_V3_FACTORY);
        address pool = factory.getPool(sol, weth, fee);
        if (pool == address(0)) {
            pool = factory.createPool(sol, weth, fee);
            console2.log("Created Uniswap V3 pool", pool);
            IUniswapV3Pool(pool).initialize(sqrtPriceX96);
            console2.log("Initialized pool at sqrtPriceX96", sqrtPriceX96);
        } else {
            console2.log("Pool already exists", pool);
        }

        vm.stopBroadcast();

        console2.log("---");
        console2.log("NEXT_PUBLIC_SEPOLIA_SOL_TOKEN=", sol);
        console2.log("SEPOLIA_SOL_TOKEN=", sol);
        console2.log("POOL=", pool);
        console2.log("WETH=", weth);
        console2.log("FEE=", uint256(fee));
        console2.log("Remember: vault setTokenAllowed(sol, true) + settlement approve.");
    }
}

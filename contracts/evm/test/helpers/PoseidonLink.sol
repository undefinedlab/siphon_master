// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @dev Put the linked Poseidon libraries on the test chain.
///
/// foundry.toml pins PoseidonT3/T4 to their canonical on-chain addresses, because our own via_ir
/// build of them is over EIP-170 (29315 / 32895 > 24576) and cannot be deployed to any real chain.
/// Those addresses exist on Sepolia and Base but not in the test EVM, and solc links them at
/// compile time — so without this every hashing test reverts in setUp.
///
/// Etching our locally compiled bytecode is sound here: same source, same Poseidon constants, and
/// `hash` is `public pure`, so there is no library call-protection tied to the deploy address. The
/// canonical builds differ only in compiler settings, which is exactly why ours is oversized.
library PoseidonLink {
    address internal constant POSEIDON_T3 = 0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93;
    address internal constant POSEIDON_T4 = 0x4443338EF595F44e0121df4C21102677B142ECF0;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function etch() internal {
        if (POSEIDON_T3.code.length == 0) {
            vm.etch(POSEIDON_T3, vm.getDeployedCode("PoseidonT3.sol:PoseidonT3"));
        }
        if (POSEIDON_T4.code.length == 0) {
            vm.etch(POSEIDON_T4, vm.getDeployedCode("PoseidonT4.sol:PoseidonT4"));
        }
    }
}

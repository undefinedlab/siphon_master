// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

import {IPayeeCodec} from "../interfaces/IPayeeCodec.sol";

/// @title PayeeCodecEvm
/// @notice `payeeId = Poseidon(DOMAIN_PAYEE, uint160(addr))` — evm-v1 / PROTOCOL §1.2.
contract PayeeCodecEvm is IPayeeCodec {
    uint256 internal constant DOMAIN_PAYEE = 4;

    error BadRawPayee();

    function payeeId(bytes calldata rawPayee) external pure override returns (uint256) {
        if (rawPayee.length != 20) revert BadRawPayee();
        uint256 payeeField = uint256(uint160(address(bytes20(rawPayee))));
        return PoseidonT3.hash([DOMAIN_PAYEE, payeeField]);
    }
}

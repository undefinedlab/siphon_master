pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "./domains.circom";

// EVM payee encoding — chain-profiles/evm-v1.json, spend-core chain_profile.rs
// payeeField = uint256(bytes32(0x00..00 || rawPayee[20])) big-endian
// payeeId = Poseidon(DOMAIN_PAYEE, payeeField)

template EvmPayeeField() {
    signal input rawPayee[20];
    signal output payeeField;

    component byteRange[20];
    for (var i = 0; i < 20; i++) {
        byteRange[i] = LessEqThan(8);
        byteRange[i].in[0] <== rawPayee[i];
        byteRange[i].in[1] <== 255;
        byteRange[i].out === 1;
    }

    signal acc[21];
    acc[0] <== 0;
    for (var i = 0; i < 20; i++) {
        var p = 1;
        for (var k = 0; k < 19 - i; k++) {
            p = p * 256;
        }
        acc[i + 1] <== acc[i] + rawPayee[i] * p;
    }
    payeeField <== acc[20];
}

template PayeeIdEvm() {
    signal input rawPayee[20];
    signal input expectedPayeeId;

    component pf = EvmPayeeField();
    for (var i = 0; i < 20; i++) {
        pf.rawPayee[i] <== rawPayee[i];
    }

    component h = Poseidon(2);
    h.inputs[0] <== DOMAIN_PAYEE();
    h.inputs[1] <== pf.payeeField;

    expectedPayeeId === h.out;
}

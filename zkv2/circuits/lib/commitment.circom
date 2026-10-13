pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";

// Matches Solidity CommitmentLib / Poseidon (D1, PROGRAM_VERSION ≥ 3 — unchanged in v4):
//   precommitment = Poseidon(nullifier, secret)
//   commitment    = Poseidon(Poseidon(amount, label, assetId), precommitment)

template CommitmentHasher() {
    signal input amount;
    signal input label;
    signal input assetId;
    signal input nullifier;
    signal input secret;
    signal output commitment;
    signal output precommitment;

    component pre = Poseidon(2);
    pre.inputs[0] <== nullifier;
    pre.inputs[1] <== secret;
    precommitment <== pre.out;

    component inner = Poseidon(3);
    inner.inputs[0] <== amount;
    inner.inputs[1] <== label;
    inner.inputs[2] <== assetId;

    component outer = Poseidon(2);
    outer.inputs[0] <== inner.out;
    outer.inputs[1] <== pre.out;
    commitment <== outer.out;
}

template LabelHasher() {
    signal input scope;
    signal input nonce;
    signal output label;

    component h = Poseidon(2);
    h.inputs[0] <== scope;
    h.inputs[1] <== nonce;
    label <== h.out;
}

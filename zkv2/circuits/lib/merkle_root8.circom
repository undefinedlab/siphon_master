pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";

// Depth-3 binary Poseidon Merkle root over 8 leaves — PROTOCOL §4.4.

template MerkleRoot8() {
    signal input leaves[8];
    signal output root;

    component l1[4];
    signal mid1[4];
    for (var i = 0; i < 4; i++) {
        l1[i] = Poseidon(2);
        l1[i].inputs[0] <== leaves[2 * i];
        l1[i].inputs[1] <== leaves[2 * i + 1];
        mid1[i] <== l1[i].out;
    }

    component l2[2];
    signal mid2[2];
    for (var i = 0; i < 2; i++) {
        l2[i] = Poseidon(2);
        l2[i].inputs[0] <== mid1[2 * i];
        l2[i].inputs[1] <== mid1[2 * i + 1];
        mid2[i] <== l2[i].out;
    }

    component top = Poseidon(2);
    top.inputs[0] <== mid2[0];
    top.inputs[1] <== mid2[1];
    root <== top.out;
}

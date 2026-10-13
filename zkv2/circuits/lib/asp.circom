pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "./merkle_tree.circom";

// ASP association Merkle — PROTOCOL.md §2.6 / spend-core asp.rs
// Path bind is LSB-first at level 0 (matches on-chain MerkleTree.sol / PROTOCOL §2.6.1).

template AspInclusion(levels) {
    signal input label;
    signal input root;
    signal input leafIndex;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component idxBits = Num2Bits(levels);
    idxBits.in <== leafIndex;
    for (var j = 0; j < levels; j++) {
        pathIndices[j] === idxBits.out[j];
    }

    component checker = MerkleTreeChecker(levels);
    checker.leaf <== label;
    for (var j = 0; j < levels; j++) {
        checker.pathElements[j] <== pathElements[j];
        checker.pathIndices[j] <== pathIndices[j];
    }
    checker.root === root;
}

template AspInclusionIfEnabled(levels) {
    signal input enabled;
    signal input label;
    signal input root;
    signal input leafIndex;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component idxBits = Num2Bits(levels);
    idxBits.in <== leafIndex;

    component checker = MerkleTreeChecker(levels);
    checker.leaf <== label;
    for (var j = 0; j < levels; j++) {
        enabled * (pathIndices[j] - idxBits.out[j]) === 0;
        checker.pathElements[j] <== pathElements[j];
        checker.pathIndices[j] <== pathIndices[j];
    }
    enabled * (checker.root - root) === 0;
}

// Empty ASP root: Poseidon(z,z) iterated `levels` times from z=0.
template EmptyAspRoot(levels) {
    signal output root;
    signal z[levels + 1];
    z[0] <== 0;
    component h[levels];
    for (var i = 0; i < levels; i++) {
        h[i] = Poseidon(2);
        h[i].inputs[0] <== z[i];
        h[i].inputs[1] <== z[i];
        z[i + 1] <== h[i].out;
    }
    root <== z[levels];
}

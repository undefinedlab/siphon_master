pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./merkle_tree.circom";
include "./domains.circom";

// Revocation SMT — PROTOCOL.md §2.5
// pathIndices[j] = bit (253-j) of smtKey (MSB-first, depth 32).
//
// Non-inclusion (F-5): prove Merkle path to the *actual* leaf at that 32-bit
// slot and constrain leaf ≠ leafHash(label). Same depth-32 tree — no longer
// keys. A colliding revoke occupying the slot cannot freeze an unrevoked label.

template SmtKey() {
    signal input label;
    signal output key;

    component h = Poseidon(2);
    h.inputs[0] <== DOMAIN_SMT_KEY();
    h.inputs[1] <== label;
    key <== h.out;
}

template SmtLeafHash() {
    signal input label;
    signal output leaf;

    component h = Poseidon(2);
    h.inputs[0] <== DOMAIN_SMT_LEAF();
    h.inputs[1] <== label;
    leaf <== h.out;
}

// Split key = high * 2^222 + low, then bind path to the 32 MSBs only.
// Cheaper than Num2Bits(254): only Num2Bits(32)+Num2Bits(222).
template SplitKeyMsb32() {
    signal input key;
    signal output high;
    signal output low;
    signal output highBits[32];

    var TWO222 = 2 ** 222;

    high <-- key \ TWO222;
    low <-- key - high * TWO222;
    high * TWO222 + low === key;

    component hb = Num2Bits(32);
    hb.in <== high;
    component lb = Num2Bits(222);
    lb.in <== low;

    for (var i = 0; i < 32; i++) {
        highBits[i] <== hb.out[i];
    }
}

// Bind pathIndices[j] = bit(253-j) of key via 32 MSBs (levels MUST be 32).
template BindPathMsb(levels) {
    assert(levels == 32);
    signal input key;
    signal input pathIndices[levels];

    component split = SplitKeyMsb32();
    split.key <== key;
    for (var j = 0; j < levels; j++) {
        // highBits[0]=LSB of high = key bit 222; highBits[31]=MSB = key bit 253
        pathIndices[j] === split.highBits[31 - j];
    }
}

template SmtNonInclusion(levels) {
    signal input label;
    signal input root;
    // Actual leaf at smtKey(label)'s 32-bit slot (0 if empty; else some leafHash).
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component keyH = SmtKey();
    keyH.label <== label;

    component leafH = SmtLeafHash();
    leafH.label <== label;

    // leaf ≠ leafHash(label) — blocks self-revocation; allows foreign occupant.
    component eqMine = IsEqual();
    eqMine.in[0] <== leaf;
    eqMine.in[1] <== leafH.leaf;
    eqMine.out === 0;

    component bind = BindPathMsb(levels);
    bind.key <== keyH.key;
    for (var j = 0; j < levels; j++) {
        bind.pathIndices[j] <== pathIndices[j];
    }

    component checker = MerkleTreeChecker(levels);
    checker.leaf <== leaf;
    for (var j = 0; j < levels; j++) {
        checker.pathElements[j] <== pathElements[j];
        checker.pathIndices[j] <== pathIndices[j];
    }
    checker.root === root;
}

template SmtInclusion(levels) {
    signal input label;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component keyH = SmtKey();
    keyH.label <== label;

    component leafH = SmtLeafHash();
    leafH.label <== label;

    component bind = BindPathMsb(levels);
    bind.key <== keyH.key;
    for (var j = 0; j < levels; j++) {
        bind.pathIndices[j] <== pathIndices[j];
    }

    component checker = MerkleTreeChecker(levels);
    checker.leaf <== leafH.leaf;
    for (var j = 0; j < levels; j++) {
        checker.pathElements[j] <== pathElements[j];
        checker.pathIndices[j] <== pathIndices[j];
    }
    checker.root === root;
}

// Soft SMT non-inclusion gated by `enabled` (0/1).
template SmtNonInclusionIfEnabled(levels) {
    signal input enabled;
    signal input label;
    signal input root;
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component keyH = SmtKey();
    keyH.label <== label;

    component leafH = SmtLeafHash();
    leafH.label <== label;

    component eqMine = IsEqual();
    eqMine.in[0] <== leaf;
    eqMine.in[1] <== leafH.leaf;
    enabled * eqMine.out === 0;

    component split = SplitKeyMsb32();
    split.key <== keyH.key;

    component checker = MerkleTreeChecker(levels);
    checker.leaf <== leaf;
    for (var j = 0; j < levels; j++) {
        enabled * (pathIndices[j] - split.highBits[31 - j]) === 0;
        checker.pathElements[j] <== pathElements[j];
        checker.pathIndices[j] <== pathIndices[j];
    }

    enabled * (checker.root - root) === 0;
}

// Soft SMT inclusion gated by `enabled` (0/1).
template SmtInclusionIfEnabled(levels) {
    signal input enabled;
    signal input label;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component keyH = SmtKey();
    keyH.label <== label;

    component leafH = SmtLeafHash();
    leafH.label <== label;

    component split = SplitKeyMsb32();
    split.key <== keyH.key;

    component checker = MerkleTreeChecker(levels);
    checker.leaf <== leafH.leaf;
    for (var j = 0; j < levels; j++) {
        enabled * (pathIndices[j] - split.highBits[31 - j]) === 0;
        checker.pathElements[j] <== pathElements[j];
        checker.pathIndices[j] <== pathIndices[j];
    }

    enabled * (checker.root - root) === 0;
}

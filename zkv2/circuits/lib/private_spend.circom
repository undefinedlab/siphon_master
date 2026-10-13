pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/gates.circom";
include "./commitment.circom";
include "./merkle_tree.circom";
include "./asp.circom";
include "./smt.circom";
include "./domains.circom";

// Shared §5.1 private-spend checks for up to maxN slots.
// Active iff i < inputCount. Inactive slots force inValue/inLabel/inNullifier = 0.

template PrivateSpendInputs(levels, maxN) {
    signal input inputCount;
    signal input stateRoot;
    signal input admittedRoot;
    signal input revokedRoot;

    signal input inValue[maxN];
    signal input inNullifier[maxN];
    signal input inSecret[maxN];
    signal input inLabel[maxN];
    signal input inAssetId[maxN];
    signal input statePathElements[maxN][levels];
    signal input statePathIndices[maxN][levels];
    signal input admittedLeafIndex[maxN];
    signal input admittedPathElements[maxN][levels];
    signal input admittedPathIndices[maxN][levels];
    signal input revokedSmtPathElements[maxN][levels];
    signal input revokedSmtPathIndices[maxN][levels];
    // Actual SMT leaf at each input's smtKey slot (0 if empty). F-5 non-inclusion.
    signal input revokedSmtLeaf[maxN];

    // Bound against outNullifier when used (pass 0 to skip uniqueness vs out).
    signal input outNullifier;

    signal output nullifierHash[maxN];
    signal output enabled[maxN];

    component lt[maxN];
    component inRange[maxN];
    component inZero[maxN];
    component labelZero[maxN];
    component assetZero[maxN];
    component note[maxN];
    component stateChk[maxN];
    component aspChk[maxN];
    component smtChk[maxN];
    component nh[maxN];

    // inputCount ∈ [0, maxN]
    component countHi = LessEqThan(8);
    countHi.in[0] <== inputCount;
    countHi.in[1] <== maxN;
    countHi.out === 1;

    for (var i = 0; i < maxN; i++) {
        lt[i] = LessThan(8);
        lt[i].in[0] <== i;
        lt[i].in[1] <== inputCount;
        enabled[i] <== lt[i].out;

        // Inactive → zero secrets fields used in publics / uniqueness.
        (1 - enabled[i]) * inValue[i] === 0;
        (1 - enabled[i]) * inLabel[i] === 0;
        (1 - enabled[i]) * inAssetId[i] === 0;
        (1 - enabled[i]) * inNullifier[i] === 0;

        inRange[i] = LessEqThan(128);
        inRange[i].in[0] <== inValue[i];
        inRange[i].in[1] <== 340282366920938463463374607431768211455;
        // When disabled, 0 ≤ max always holds.
        inRange[i].out === 1;

        inZero[i] = IsZero();
        inZero[i].in <== inValue[i];
        // Active ⇒ value ≠ 0; inactive ⇒ value = 0 ⇒ IsZero=1. So enabled ⇒ !IsZero.
        enabled[i] * inZero[i].out === 0;

        labelZero[i] = IsZero();
        labelZero[i].in <== inLabel[i];
        enabled[i] * labelZero[i].out === 0;

        // OVERLORD F-2: active notes MUST have assetId ≠ 0.
        assetZero[i] = IsZero();
        assetZero[i].in <== inAssetId[i];
        enabled[i] * assetZero[i].out === 0;

        note[i] = CommitmentHasher();
        note[i].amount <== inValue[i];
        note[i].label <== inLabel[i];
        note[i].assetId <== inAssetId[i];
        note[i].nullifier <== inNullifier[i];
        note[i].secret <== inSecret[i];

        stateChk[i] = MerkleTreeChecker(levels);
        stateChk[i].leaf <== note[i].commitment;
        for (var j = 0; j < levels; j++) {
            stateChk[i].pathElements[j] <== statePathElements[i][j];
            stateChk[i].pathIndices[j] <== statePathIndices[i][j];
        }
        enabled[i] * (stateChk[i].root - stateRoot) === 0;

        aspChk[i] = AspInclusionIfEnabled(levels);
        aspChk[i].enabled <== enabled[i];
        aspChk[i].label <== inLabel[i];
        aspChk[i].root <== admittedRoot;
        aspChk[i].leafIndex <== admittedLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            aspChk[i].pathElements[j] <== admittedPathElements[i][j];
            aspChk[i].pathIndices[j] <== admittedPathIndices[i][j];
        }

        smtChk[i] = SmtNonInclusionIfEnabled(levels);
        smtChk[i].enabled <== enabled[i];
        smtChk[i].label <== inLabel[i];
        smtChk[i].root <== revokedRoot;
        smtChk[i].leaf <== revokedSmtLeaf[i];
        for (var j = 0; j < levels; j++) {
            smtChk[i].pathElements[j] <== revokedSmtPathElements[i][j];
            smtChk[i].pathIndices[j] <== revokedSmtPathIndices[i][j];
        }

        nh[i] = Poseidon(1);
        nh[i].inputs[0] <== inNullifier[i];
        nullifierHash[i] <== enabled[i] * nh[i].out;
    }

    // Pairwise distinct nullifiers / labels among active slots.
    var pair = 0;
    component nullUnique[maxN * (maxN - 1) / 2];
    component labelUnique[maxN * (maxN - 1) / 2];
    component bothActive[maxN * (maxN - 1) / 2];
    for (var i = 0; i < maxN; i++) {
        for (var k = i + 1; k < maxN; k++) {
            bothActive[pair] = AND();
            bothActive[pair].a <== enabled[i];
            bothActive[pair].b <== enabled[k];

            nullUnique[pair] = IsZero();
            nullUnique[pair].in <== inNullifier[i] - inNullifier[k];
            bothActive[pair].out * nullUnique[pair].out === 0;

            labelUnique[pair] = IsZero();
            labelUnique[pair].in <== inLabel[i] - inLabel[k];
            bothActive[pair].out * labelUnique[pair].out === 0;
            pair++;
        }
    }

    // Active notes MUST share one assetId (MERGE/WITHDRAW multi-input).
    for (var i = 0; i < maxN; i++) {
        enabled[i] * (inAssetId[i] - inAssetId[0]) === 0;
    }

    // Active nullifiers ≠ outNullifier (when outNullifier ≠ 0, still safe if equal to 0 inactive).
    component vsOut[maxN];
    for (var i = 0; i < maxN; i++) {
        vsOut[i] = IsZero();
        vsOut[i].in <== inNullifier[i] - outNullifier;
        enabled[i] * vsOut[i].out === 0;
    }
}

template BindPublicCore() {
    signal input publicInputs[25];
    signal input action;
    signal input inputCount;
    signal input stateRoot;
    signal input admittedRoot;
    signal input revokedRoot;
    signal input programVersion;

    publicInputs[0] === action;
    publicInputs[1] === inputCount;
    publicInputs[2] === stateRoot;
    publicInputs[3] === admittedRoot;
    publicInputs[4] === revokedRoot;
    publicInputs[8] === 0;
    publicInputs[16] === programVersion;
    programVersion === PROGRAM_VERSION();
}

template BindNullifierPublics(N) {
    signal input publicInputs[25];
    signal input nullifierHash[N];
    for (var i = 0; i < N; i++) {
        publicInputs[9 + i] === nullifierHash[i];
    }
    for (var i = N; i < 6; i++) {
        publicInputs[9 + i] === 0;
    }
}

// Exact-N private spend: all N slots active (no enabled padding). Use for per-N withdraw.
template PrivateSpendInputsExact(levels, N) {
    signal input stateRoot;
    signal input admittedRoot;
    signal input revokedRoot;

    signal input inValue[N];
    signal input inNullifier[N];
    signal input inSecret[N];
    signal input inLabel[N];
    signal input inAssetId[N];
    signal input statePathElements[N][levels];
    signal input statePathIndices[N][levels];
    signal input admittedLeafIndex[N];
    signal input admittedPathElements[N][levels];
    signal input admittedPathIndices[N][levels];
    signal input revokedSmtPathElements[N][levels];
    signal input revokedSmtPathIndices[N][levels];
    signal input revokedSmtLeaf[N];
    signal input outNullifier;

    signal output nullifierHash[N];

    component inRange[N];
    component inZero[N];
    component labelZero[N];
    component assetZero[N];
    component note[N];
    component stateChk[N];
    component aspChk[N];
    component smtChk[N];
    component nh[N];

    for (var i = 0; i < N; i++) {
        inRange[i] = LessEqThan(128);
        inRange[i].in[0] <== inValue[i];
        inRange[i].in[1] <== 340282366920938463463374607431768211455;
        inRange[i].out === 1;

        inZero[i] = IsZero();
        inZero[i].in <== inValue[i];
        inZero[i].out === 0;

        labelZero[i] = IsZero();
        labelZero[i].in <== inLabel[i];
        labelZero[i].out === 0;

        // OVERLORD F-2: assetId ≠ 0 for every exact-N slot.
        assetZero[i] = IsZero();
        assetZero[i].in <== inAssetId[i];
        assetZero[i].out === 0;

        note[i] = CommitmentHasher();
        note[i].amount <== inValue[i];
        note[i].label <== inLabel[i];
        note[i].assetId <== inAssetId[i];
        note[i].nullifier <== inNullifier[i];
        note[i].secret <== inSecret[i];

        stateChk[i] = MerkleTreeChecker(levels);
        stateChk[i].leaf <== note[i].commitment;
        for (var j = 0; j < levels; j++) {
            stateChk[i].pathElements[j] <== statePathElements[i][j];
            stateChk[i].pathIndices[j] <== statePathIndices[i][j];
        }
        stateChk[i].root === stateRoot;

        aspChk[i] = AspInclusion(levels);
        aspChk[i].label <== inLabel[i];
        aspChk[i].root <== admittedRoot;
        aspChk[i].leafIndex <== admittedLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            aspChk[i].pathElements[j] <== admittedPathElements[i][j];
            aspChk[i].pathIndices[j] <== admittedPathIndices[i][j];
        }

        smtChk[i] = SmtNonInclusion(levels);
        smtChk[i].label <== inLabel[i];
        smtChk[i].root <== revokedRoot;
        smtChk[i].leaf <== revokedSmtLeaf[i];
        for (var j = 0; j < levels; j++) {
            smtChk[i].pathElements[j] <== revokedSmtPathElements[i][j];
            smtChk[i].pathIndices[j] <== revokedSmtPathIndices[i][j];
        }

        nh[i] = Poseidon(1);
        nh[i].inputs[0] <== inNullifier[i];
        nullifierHash[i] <== nh[i].out;
    }

    var pair = 0;
    component nullUnique[N * (N - 1) / 2];
    component labelUnique[N * (N - 1) / 2];
    for (var i = 0; i < N; i++) {
        for (var k = i + 1; k < N; k++) {
            nullUnique[pair] = IsZero();
            nullUnique[pair].in <== inNullifier[i] - inNullifier[k];
            nullUnique[pair].out === 0;

            labelUnique[pair] = IsZero();
            labelUnique[pair].in <== inLabel[i] - inLabel[k];
            labelUnique[pair].out === 0;
            pair++;
        }
    }

    for (var i = 0; i < N; i++) {
        inAssetId[i] - inAssetId[0] === 0;
    }

    component vsOut[N];
    for (var i = 0; i < N; i++) {
        vsOut[i] = IsZero();
        vsOut[i].in <== inNullifier[i] - outNullifier;
        vsOut[i].out === 0;
    }
}

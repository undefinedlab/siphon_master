pragma circom 2.0.0;
include "../lib/private_spend.circom";
include "../lib/commitment.circom";
include "../lib/merkle_root8.circom";
include "../lib/domains.circom";
include "circomlib/circuits/comparators.circom";

// SPLIT — PROTOCOL.md §6.4 / §4.4, publicInputs[25].

template Split(levels, nOut) {
    signal input publicInputs[25];

    signal input inValue;
    signal input inNullifier;
    signal input inSecret;
    signal input inLabel;
    signal input inAssetId;
    signal input statePathElements[levels];
    signal input statePathIndices[levels];
    signal input admittedLeafIndex;
    signal input admittedPathElements[levels];
    signal input admittedPathIndices[levels];
    signal input revokedSmtPathElements[levels];
    signal input revokedSmtPathIndices[levels];
    signal input revokedSmtLeaf;
    signal input outValue[nOut];
    signal input outNullifier[nOut];
    signal input outSecret[nOut];

    signal action <== publicInputs[0];
    signal inputCount <== publicInputs[1];
    signal stateRoot <== publicInputs[2];
    signal admittedRoot <== publicInputs[3];
    signal revokedRoot <== publicInputs[4];
    signal splitRootPub <== publicInputs[17];

    action === ACTION_SPLIT();
    inputCount === 1;
    publicInputs[5] === 0;
    publicInputs[6] === 0;
    publicInputs[7] === 0;
    publicInputs[15] === 0;

    component core = BindPublicCore();
    for (var i = 0; i < 25; i++) core.publicInputs[i] <== publicInputs[i];
    core.action <== action;
    core.inputCount <== inputCount;
    core.stateRoot <== stateRoot;
    core.admittedRoot <== admittedRoot;
    core.revokedRoot <== revokedRoot;
    core.programVersion <== publicInputs[16];

    component inputs = PrivateSpendInputs(levels, 1);
    inputs.inputCount <== 1;
    inputs.stateRoot <== stateRoot;
    inputs.admittedRoot <== admittedRoot;
    inputs.revokedRoot <== revokedRoot;
    inputs.outNullifier <== 0;
    inputs.inValue[0] <== inValue;
    inputs.inNullifier[0] <== inNullifier;
    inputs.inSecret[0] <== inSecret;
    inputs.inLabel[0] <== inLabel;
    inputs.inAssetId[0] <== inAssetId;
    inputs.admittedLeafIndex[0] <== admittedLeafIndex;
    for (var j = 0; j < levels; j++) {
        inputs.statePathElements[0][j] <== statePathElements[j];
        inputs.statePathIndices[0][j] <== statePathIndices[j];
        inputs.admittedPathElements[0][j] <== admittedPathElements[j];
        inputs.admittedPathIndices[0][j] <== admittedPathIndices[j];
        inputs.revokedSmtPathElements[0][j] <== revokedSmtPathElements[j];
        inputs.revokedSmtPathIndices[0][j] <== revokedSmtPathIndices[j];
    }
    inputs.revokedSmtLeaf[0] <== revokedSmtLeaf;

    component nhPub = BindNullifierPublics(1);
    for (var i = 0; i < 25; i++) nhPub.publicInputs[i] <== publicInputs[i];
    nhPub.nullifierHash[0] <== inputs.nullifierHash[0];
    publicInputs[10] === 0;
    publicInputs[11] === 0;
    publicInputs[12] === 0;
    publicInputs[13] === 0;
    publicInputs[14] === 0;

    component outRange[nOut];
    component outZero[nOut];
    component outNote[nOut];
    signal outCommitment[nOut];
    signal active[nOut];
    signal sum[nOut + 1];
    sum[0] <== 0;

    for (var i = 0; i < nOut; i++) {
        outRange[i] = LessEqThan(128);
        outRange[i].in[0] <== outValue[i];
        outRange[i].in[1] <== 340282366920938463463374607431768211455;
        outRange[i].out === 1;

        outZero[i] = IsZero();
        outZero[i].in <== outValue[i];
        active[i] <== 1 - outZero[i].out;

        outZero[i].out * outNullifier[i] === 0;
        outZero[i].out * outSecret[i] === 0;

        outNote[i] = CommitmentHasher();
        outNote[i].amount <== outValue[i];
        outNote[i].label <== inLabel;
        outNote[i].assetId <== inAssetId;
        outNote[i].nullifier <== outNullifier[i];
        outNote[i].secret <== outSecret[i];
        outCommitment[i] <== active[i] * outNote[i].commitment;

        sum[i + 1] <== sum[i] + outValue[i];
    }
    sum[nOut] === inValue;

    component root8 = MerkleRoot8();
    for (var i = 0; i < 8; i++) {
        root8.leaves[i] <== outCommitment[i];
    }
    splitRootPub === root8.root;

    component vsIn[nOut];
    for (var i = 0; i < nOut; i++) {
        vsIn[i] = IsZero();
        vsIn[i].in <== inNullifier - outNullifier[i];
        active[i] * vsIn[i].out === 0;
    }

    var pair = 0;
    signal bothActive[nOut * (nOut - 1) / 2];
    component outPair[nOut * (nOut - 1) / 2];
    for (var i = 0; i < nOut; i++) {
        for (var k = i + 1; k < nOut; k++) {
            bothActive[pair] <== active[i] * active[k];
            outPair[pair] = IsZero();
            outPair[pair].in <== outNullifier[i] - outNullifier[k];
            bothActive[pair] * outPair[pair].out === 0;
            pair++;
        }
    }

    for (var m = 18; m < 25; m++) {
        publicInputs[m] === 0;
    }
}

pragma circom 2.0.0;
include "../lib/private_spend.circom";
include "../lib/commitment.circom";
include "../lib/domains.circom";
include "../lib/payee.circom";
include "circomlib/circuits/comparators.circom";

// WITHDRAW — PROTOCOL.md §6.1, publicInputs[25].
// Exact-N circuit: inputCount is fixed to N (per-N mains withdraw1..withdraw6).

template Withdrawal(levels, N) {
    signal input publicInputs[25];

    signal input boundaryIndex;
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
    signal input outSecret;

    signal action <== publicInputs[0];
    signal inputCount <== publicInputs[1];
    signal stateRoot <== publicInputs[2];
    signal admittedRoot <== publicInputs[3];
    signal revokedRoot <== publicInputs[4];
    signal primaryValue <== publicInputs[5];
    signal secondaryValue <== publicInputs[6];
    signal outCommitment <== publicInputs[7];

    action === ACTION_WITHDRAW();
    inputCount === N;

    component kBound = LessThan(8);
    kBound.in[0] <== boundaryIndex;
    kBound.in[1] <== N;
    kBound.out === 1;

    component core = BindPublicCore();
    for (var i = 0; i < 25; i++) core.publicInputs[i] <== publicInputs[i];
    core.action <== action;
    core.inputCount <== inputCount;
    core.stateRoot <== stateRoot;
    core.admittedRoot <== admittedRoot;
    core.revokedRoot <== revokedRoot;
    core.programVersion <== publicInputs[16];

    component inputs = PrivateSpendInputsExact(levels, N);
    inputs.stateRoot <== stateRoot;
    inputs.admittedRoot <== admittedRoot;
    inputs.revokedRoot <== revokedRoot;
    inputs.outNullifier <== outNullifier;
    for (var i = 0; i < N; i++) {
        inputs.inValue[i] <== inValue[i];
        inputs.inNullifier[i] <== inNullifier[i];
        inputs.inSecret[i] <== inSecret[i];
        inputs.inLabel[i] <== inLabel[i];
        inputs.inAssetId[i] <== inAssetId[i];
        inputs.admittedLeafIndex[i] <== admittedLeafIndex[i];
        for (var j = 0; j < levels; j++) {
            inputs.statePathElements[i][j] <== statePathElements[i][j];
            inputs.statePathIndices[i][j] <== statePathIndices[i][j];
            inputs.admittedPathElements[i][j] <== admittedPathElements[i][j];
            inputs.admittedPathIndices[i][j] <== admittedPathIndices[i][j];
            inputs.revokedSmtPathElements[i][j] <== revokedSmtPathElements[i][j];
            inputs.revokedSmtPathIndices[i][j] <== revokedSmtPathIndices[i][j];
        }
        inputs.revokedSmtLeaf[i] <== revokedSmtLeaf[i];
    }

    component nhPub = BindNullifierPublics(N);
    for (var i = 0; i < 25; i++) nhPub.publicInputs[i] <== publicInputs[i];
    for (var i = 0; i < N; i++) nhPub.nullifierHash[i] <== inputs.nullifierHash[i];

    signal sum[N + 1];
    sum[0] <== 0;
    for (var i = 0; i < N; i++) {
        sum[i + 1] <== sum[i] + inValue[i];
    }

    component primaryNonZero = IsZero();
    primaryNonZero.in <== primaryValue;
    primaryNonZero.out === 0;

    primaryValue + secondaryValue === sum[N];

    component eqK[N];
    signal isBoundary[N];
    signal bVal[N + 1];
    signal bLabel[N + 1];
    bVal[0] <== 0;
    bLabel[0] <== 0;
    for (var i = 0; i < N; i++) {
        eqK[i] = IsEqual();
        eqK[i].in[0] <== boundaryIndex;
        eqK[i].in[1] <== i;
        isBoundary[i] <== eqK[i].out;
        bVal[i + 1] <== bVal[i] + isBoundary[i] * inValue[i];
        bLabel[i + 1] <== bLabel[i] + isBoundary[i] * inLabel[i];
    }

    // Fractional change (PROGRAM_VERSION 4, §6.1): change note may be ANY value from 0 up to
    // the boundary note's full value — carved from the boundary note, all other inputs fully
    // consumed. Replaces the v3 "change == 0 OR change == boundary" rule. Safety is the circuit
    // constraint below (LessEqThan(128), BN254-safe per Num2Bits underflow rule), NOT client
    // note-selection — a malicious client cannot pass secondary > boundary value.
    component secZero = IsZero();
    secZero.in <== secondaryValue;
    component secLeBound = LessEqThan(128);
    secLeBound.in[0] <== secondaryValue;
    secLeBound.in[1] <== bVal[N];
    secLeBound.out === 1;

    component outNote = CommitmentHasher();
    outNote.amount <== secondaryValue;
    outNote.label <== bLabel[N];
    outNote.assetId <== inAssetId[0];
    outNote.nullifier <== outNullifier;
    outNote.secret <== outSecret;

    signal expectedOut <== (1 - secZero.out) * outNote.commitment;
    outCommitment === expectedOut;

    // D1: public[17] = assetId
    publicInputs[17] === inAssetId[0];
    for (var m = 18; m < 25; m++) {
        publicInputs[m] === 0;
    }

    signal input rawPayee[20];
    component payeeBind = PayeeIdEvm();
    for (var p = 0; p < 20; p++) {
        payeeBind.rawPayee[p] <== rawPayee[p];
    }
    payeeBind.expectedPayeeId <== publicInputs[15];
}

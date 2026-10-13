pragma circom 2.0.0;
include "../lib/merkle_tree.circom";
include "../lib/commitment.circom";
include "../lib/asp.circom";
include "../lib/smt.circom";
include "../lib/domains.circom";
include "../lib/private_spend.circom";
include "../lib/payee.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/poseidon.circom";

// RAGEQUIT — PROTOCOL.md §5.2 / §6.5, publicInputs[25].
//
// Exactly one eligibility branch:
//   pending (0): SMT non-inclusion ∧ admittedRoot == EMPTY_ASP_ROOT (bootstrap only)
//   revoked (1): SMT inclusion of inLabel (prod pre-admit / KYT-fail exit)
//
// F-8 accepted: prod ASP is non-empty after first bus. Empty-ASP pending is
// not the live path. Admitted (ASP∈) cannot ragequit — circuit enforces;
// UI/indexer "admitted" is display only. No keyed ASP non-inclusion in v1.

template Ragequit(levels) {
    signal input publicInputs[25];

    // 0 = pending, 1 = revoked
    signal input branch;

    signal input inValue;
    signal input inNullifier;
    signal input inSecret;
    signal input inLabel;
    signal input inAssetId;
    signal input statePathElements[levels];
    signal input statePathIndices[levels];
    signal input revokedSmtPathElements[levels];
    signal input revokedSmtPathIndices[levels];
    // Pending branch: actual leaf at smtKey slot (usually 0). F-5.
    signal input revokedSmtLeaf;

    signal action <== publicInputs[0];
    signal inputCount <== publicInputs[1];
    signal stateRoot <== publicInputs[2];
    signal admittedRoot <== publicInputs[3];
    signal revokedRoot <== publicInputs[4];
    signal primaryValue <== publicInputs[5];
    signal outCommitment <== publicInputs[7];

    action === ACTION_RAGEQUIT();
    inputCount === 1;
    publicInputs[6] === 0;
    publicInputs[15] === 0;

    branch * (1 - branch) === 0;

    component core = BindPublicCore();
    for (var i = 0; i < 25; i++) core.publicInputs[i] <== publicInputs[i];
    core.action <== action;
    core.inputCount <== inputCount;
    core.stateRoot <== stateRoot;
    core.admittedRoot <== admittedRoot;
    core.revokedRoot <== revokedRoot;
    core.programVersion <== publicInputs[16];

    component rangeCheck = LessEqThan(128);
    rangeCheck.in[0] <== inValue;
    rangeCheck.in[1] <== 340282366920938463463374607431768211455;
    rangeCheck.out === 1;

    component valueNonZero = IsZero();
    valueNonZero.in <== inValue;
    valueNonZero.out === 0;

    component labelNonZero = IsZero();
    labelNonZero.in <== inLabel;
    labelNonZero.out === 0;

    // OVERLORD F-2: ragequit note assetId ≠ 0.
    component assetNonZero = IsZero();
    assetNonZero.in <== inAssetId;
    assetNonZero.out === 0;

    primaryValue === inValue;

    component note = CommitmentHasher();
    note.amount <== inValue;
    note.label <== inLabel;
    note.assetId <== inAssetId;
    note.nullifier <== inNullifier;
    note.secret <== inSecret;
    outCommitment === note.commitment;
    publicInputs[18] === inAssetId;

    component stateChk = MerkleTreeChecker(levels);
    stateChk.leaf <== note.commitment;
    for (var j = 0; j < levels; j++) {
        stateChk.pathElements[j] <== statePathElements[j];
        stateChk.pathIndices[j] <== statePathIndices[j];
    }
    stateChk.root === stateRoot;

    component nh = Poseidon(1);
    nh.inputs[0] <== inNullifier;
    publicInputs[9] === nh.out;
    publicInputs[10] === 0;
    publicInputs[11] === 0;
    publicInputs[12] === 0;
    publicInputs[13] === 0;
    publicInputs[14] === 0;

    // Revoked: SMT inclusion
    component smtIncSoft = SmtInclusionIfEnabled(levels);
    smtIncSoft.enabled <== branch;
    smtIncSoft.label <== inLabel;
    smtIncSoft.root <== revokedRoot;
    for (var j = 0; j < levels; j++) {
        smtIncSoft.pathElements[j] <== revokedSmtPathElements[j];
        smtIncSoft.pathIndices[j] <== revokedSmtPathIndices[j];
    }

    // Pending: SMT non-inclusion + empty ASP root
    component smtNonSoft = SmtNonInclusionIfEnabled(levels);
    smtNonSoft.enabled <== 1 - branch;
    smtNonSoft.label <== inLabel;
    smtNonSoft.root <== revokedRoot;
    smtNonSoft.leaf <== revokedSmtLeaf;
    for (var j = 0; j < levels; j++) {
        smtNonSoft.pathElements[j] <== revokedSmtPathElements[j];
        smtNonSoft.pathIndices[j] <== revokedSmtPathIndices[j];
    }

    component emptyAsp = EmptyAspRoot(levels);
    component aspEmptyEq = IsEqual();
    aspEmptyEq.in[0] <== admittedRoot;
    aspEmptyEq.in[1] <== emptyAsp.root;
    (1 - branch) * (1 - aspEmptyEq.out) === 0;

    for (var m = 19; m < 25; m++) {
        publicInputs[m] === 0;
    }

    signal input rawPayee[20];
    component payeeBind = PayeeIdEvm();
    for (var p = 0; p < 20; p++) {
        payeeBind.rawPayee[p] <== rawPayee[p];
    }
    payeeBind.expectedPayeeId <== publicInputs[17];
}

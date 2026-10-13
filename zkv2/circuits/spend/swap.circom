pragma circom 2.0.0;
include "../lib/private_spend.circom";
include "../lib/commitment.circom";
include "../lib/domains.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/poseidon.circom";

// SWAP — PROTOCOL.md §6.3 (D1), publicInputs[25].
// destLabel private == inLabel[0]; srcAssetId at public[23]; dest assetId == dstToken.

template Swap(levels) {
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
    signal input outNullifier;
    signal input outSecret;
    signal input destLabel;

    signal action <== publicInputs[0];
    signal inputCount <== publicInputs[1];
    signal stateRoot <== publicInputs[2];
    signal admittedRoot <== publicInputs[3];
    signal revokedRoot <== publicInputs[4];
    signal primaryValue <== publicInputs[5];
    signal secondaryValue <== publicInputs[6];
    signal outCommitment <== publicInputs[7];
    signal pool <== publicInputs[17];
    signal dstToken <== publicInputs[18];
    signal fee <== publicInputs[19];
    signal minAmountOut <== publicInputs[20];
    signal outputPrecommitment <== publicInputs[21];
    signal destCommitment <== publicInputs[22];
    signal srcAssetId <== publicInputs[23];

    action === ACTION_SWAP();
    inputCount === 1;

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
    inputs.outNullifier <== outNullifier;
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

    component primaryNonZero = IsZero();
    primaryNonZero.in <== primaryValue;
    primaryNonZero.out === 0;

    component primaryLeq = LessEqThan(128);
    primaryLeq.in[0] <== primaryValue;
    primaryLeq.in[1] <== inValue;
    primaryLeq.out === 1;

    primaryValue + secondaryValue === inValue;

    srcAssetId === inAssetId;

    component secZero = IsZero();
    secZero.in <== secondaryValue;

    component changeNote = CommitmentHasher();
    changeNote.amount <== secondaryValue;
    changeNote.label <== inLabel;
    changeNote.assetId <== inAssetId;
    changeNote.nullifier <== outNullifier;
    changeNote.secret <== outSecret;
    outCommitment === (1 - secZero.out) * changeNote.commitment;

    destLabel === inLabel;

    // destCommitment = Poseidon(Poseidon(minAmountOut, destLabel, dstToken), outputPrecommitment)
    component inner = Poseidon(3);
    inner.inputs[0] <== minAmountOut;
    inner.inputs[1] <== destLabel;
    inner.inputs[2] <== dstToken;
    component outer = Poseidon(2);
    outer.inputs[0] <== inner.out;
    outer.inputs[1] <== outputPrecommitment;
    destCommitment === outer.out;

    component poolBits = Num2Bits(160);
    poolBits.in <== pool;
    component dstBits = Num2Bits(160);
    dstBits.in <== dstToken;
    component srcBits = Num2Bits(160);
    srcBits.in <== srcAssetId;
    // OVERLORD F-10: fee must fit Uniswap V3 uint24 (adapter BadFee otherwise).
    component feeBits = Num2Bits(24);
    feeBits.in <== fee;

    // OVERLORD F-1: free public limb — D1 pool SWAP has no EOA payout; payeeId MUST be 0.
    publicInputs[15] === 0;
    publicInputs[24] === 0;
}

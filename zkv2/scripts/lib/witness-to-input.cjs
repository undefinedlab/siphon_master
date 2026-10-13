"use strict";

/** Parse 40-char hex rawPayeeHex → 20-byte array for Circom. */
function rawPayeeBytes(rawPayeeHex) {
  const hex = rawPayeeHex.replace(/^0x/i, "");
  if (hex.length !== 40) {
    throw new Error(`rawPayeeHex must be 20 bytes (40 hex chars), got ${hex.length / 2}`);
  }
  const out = [];
  for (let i = 0; i < 20; i++) {
    out.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return out;
}

function requireAssetId(inp, ctx) {
  if (inp.inAssetId === undefined || inp.inAssetId === null || inp.inAssetId === "") {
    throw new Error(`${ctx}: inAssetId required (D1 / OVERLORD F-4)`);
  }
  return String(inp.inAssetId);
}

function mapInputSlot(inp) {
  return {
    inValue: String(inp.inValue),
    inNullifier: String(inp.inNullifier),
    inSecret: String(inp.inSecret),
    inLabel: String(inp.inLabel),
    inAssetId: requireAssetId(inp, "mapInputSlot"),
    admittedLeafIndex: String(inp.admittedLeafIndex),
    statePathElements: inp.statePathElements,
    statePathIndices: inp.statePathIndices,
    admittedPathElements: inp.admittedPathElements,
    admittedPathIndices: inp.admittedPathIndices,
    revokedSmtPathElements: inp.revokedSmtPathElements,
    revokedSmtPathIndices: inp.revokedSmtPathIndices,
    revokedSmtLeaf: String(inp.revokedSmtLeaf ?? "0"),
  };
}

/** Map spend witness JSON → Circom prover input (PROTOCOL actions). */
function witnessToCircomInput(w) {
  const action = Number(w.action);
  const n = Number(w.inputCount);
  const inp0 = w.inputs[0];

  if (action === 4) {
    return {
      publicInputs: w.expectedPublic,
      branch: String(w.ragequitBranch ?? 0),
      inValue: String(inp0.inValue),
      inNullifier: String(inp0.inNullifier),
      inSecret: String(inp0.inSecret),
      inLabel: String(inp0.inLabel),
      inAssetId: requireAssetId(inp0, "ragequit"),
      statePathElements: inp0.statePathElements,
      statePathIndices: inp0.statePathIndices,
      revokedSmtPathElements: inp0.revokedSmtPathElements,
      revokedSmtPathIndices: inp0.revokedSmtPathIndices,
      revokedSmtLeaf: String(inp0.revokedSmtLeaf ?? "0"),
      rawPayee: rawPayeeBytes(w.rawPayeeHex),
    };
  }

  if (action === 0) {
    return {
      publicInputs: w.expectedPublic,
      boundaryIndex: String(w.boundaryIndex ?? 0),
      outNullifier: String(w.outNullifier ?? "0"),
      outSecret: String(w.outSecret ?? "0"),
      inValue: w.inputs.map((i) => String(i.inValue)),
      inNullifier: w.inputs.map((i) => String(i.inNullifier)),
      inSecret: w.inputs.map((i) => String(i.inSecret)),
      inLabel: w.inputs.map((i) => String(i.inLabel)),
      inAssetId: w.inputs.map((i) => requireAssetId(i, "withdraw")),
      statePathElements: w.inputs.map((i) => i.statePathElements),
      statePathIndices: w.inputs.map((i) => i.statePathIndices),
      admittedLeafIndex: w.inputs.map((i) => String(i.admittedLeafIndex)),
      admittedPathElements: w.inputs.map((i) => i.admittedPathElements),
      admittedPathIndices: w.inputs.map((i) => i.admittedPathIndices),
      revokedSmtPathElements: w.inputs.map((i) => i.revokedSmtPathElements),
      revokedSmtPathIndices: w.inputs.map((i) => i.revokedSmtPathIndices),
      revokedSmtLeaf: w.inputs.map((i) => String(i.revokedSmtLeaf ?? "0")),
      rawPayee: rawPayeeBytes(w.rawPayeeHex),
    };
  }

  if (action === 1) {
    return {
      publicInputs: w.expectedPublic,
      boundaryIndex: String(w.boundaryIndex ?? 0),
      outNullifier: String(w.outNullifier ?? "0"),
      outSecret: String(w.outSecret ?? "0"),
      inValue: w.inputs.map((i) => String(i.inValue)),
      inNullifier: w.inputs.map((i) => String(i.inNullifier)),
      inSecret: w.inputs.map((i) => String(i.inSecret)),
      inLabel: w.inputs.map((i) => String(i.inLabel)),
      inAssetId: w.inputs.map((i) => requireAssetId(i, "merge")),
      statePathElements: w.inputs.map((i) => i.statePathElements),
      statePathIndices: w.inputs.map((i) => i.statePathIndices),
      admittedLeafIndex: w.inputs.map((i) => String(i.admittedLeafIndex)),
      admittedPathElements: w.inputs.map((i) => i.admittedPathElements),
      admittedPathIndices: w.inputs.map((i) => i.admittedPathIndices),
      revokedSmtPathElements: w.inputs.map((i) => i.revokedSmtPathElements),
      revokedSmtPathIndices: w.inputs.map((i) => i.revokedSmtPathIndices),
      revokedSmtLeaf: w.inputs.map((i) => String(i.revokedSmtLeaf ?? "0")),
    };
  }

  if (action === 2) {
    const slot = mapInputSlot(inp0);
    return {
      publicInputs: w.expectedPublic,
      inValue: slot.inValue,
      inNullifier: slot.inNullifier,
      inSecret: slot.inSecret,
      inLabel: slot.inLabel,
      inAssetId: slot.inAssetId,
      statePathElements: slot.statePathElements,
      statePathIndices: slot.statePathIndices,
      admittedLeafIndex: slot.admittedLeafIndex,
      admittedPathElements: slot.admittedPathElements,
      admittedPathIndices: slot.admittedPathIndices,
      revokedSmtPathElements: slot.revokedSmtPathElements,
      revokedSmtPathIndices: slot.revokedSmtPathIndices,
      revokedSmtLeaf: slot.revokedSmtLeaf,
      outNullifier: String(w.outNullifier ?? "0"),
      outSecret: String(w.outSecret ?? "0"),
      destLabel: String(w.destLabel ?? inp0.inLabel),
    };
  }

  if (action === 3) {
    const slot = mapInputSlot(inp0);
    return {
      publicInputs: w.expectedPublic,
      inValue: slot.inValue,
      inNullifier: slot.inNullifier,
      inSecret: slot.inSecret,
      inLabel: slot.inLabel,
      inAssetId: slot.inAssetId,
      statePathElements: slot.statePathElements,
      statePathIndices: slot.statePathIndices,
      admittedLeafIndex: slot.admittedLeafIndex,
      admittedPathElements: slot.admittedPathElements,
      admittedPathIndices: slot.admittedPathIndices,
      revokedSmtPathElements: slot.revokedSmtPathElements,
      revokedSmtPathIndices: slot.revokedSmtPathIndices,
      revokedSmtLeaf: slot.revokedSmtLeaf,
      outValue: (w.splitValues || []).map(String),
      outNullifier: (w.splitNullifiers || []).map(String),
      outSecret: (w.splitSecrets || []).map(String),
    };
  }

  throw new Error(`witnessToCircomInput: unsupported action ${action}`);
}

module.exports = { rawPayeeBytes, witnessToCircomInput };

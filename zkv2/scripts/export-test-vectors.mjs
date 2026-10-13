#!/usr/bin/env node
/**
 * Export normative fixtures for PROTOCOL.md §13.
 * Uses circomlibjs — same Poseidon as circom tests / CommitmentLib.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildPoseidon } from "circomlibjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TV = path.join(ROOT, "test-vectors");

const domains = JSON.parse(fs.readFileSync(path.join(TV, "domains.json"), "utf8"));
const DOMAIN_SMT_KEY = BigInt(domains.DOMAIN_SMT_KEY);
const DOMAIN_SMT_LEAF = BigInt(domains.DOMAIN_SMT_LEAF);
const DOMAIN_VAULT_SCOPE = BigInt(domains.DOMAIN_VAULT_SCOPE);
const DOMAIN_PAYEE = BigInt(domains.DOMAIN_PAYEE);
const DOMAIN_CHAIN_EVM = BigInt(domains.DOMAIN_CHAIN_EVM);
const SMT_DEPTH = 32;
const EMPTY_LEAF = 0n;

function fieldStr(x) {
  return x.toString();
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash = (inputs) => BigInt(F.toObject(poseidon(inputs.map((x) => BigInt(x)))));

  const hash2 = (a, b) => hash([a, b]);
  const hash3 = (a, b, c) => hash([a, b, c]);
  const hash1 = (a) => hash([a]);

  const smtKey = (label) => hash2(DOMAIN_SMT_KEY, label);
  const leafHash = (label) => hash2(DOMAIN_SMT_LEAF, label);

  const DEFAULT_ASSET = 0x1000n;
  const commitment = async (amount, label, nullifier, secret, assetId = DEFAULT_ASSET) => {
    const pre = hash2(nullifier, secret);
    const inner = hash3(amount, label, assetId);
    return hash2(inner, pre);
  };

  const commitmentWithPre = async (amount, label, pre, assetId = DEFAULT_ASSET) => {
    const inner = hash3(amount, label, assetId);
    return hash2(inner, pre);
  };

  const merkleRoot = async (leaf, depth, pathElements, pathIndices) => {
    let current = leaf;
    for (let i = 0; i < depth; i++) {
      const sib = BigInt(pathElements[i]);
      current =
        Number(pathIndices[i]) === 0 ? hash2(current, sib) : hash2(sib, current);
    }
    return current;
  };

  const splitRoot = async (leaves) => {
    let level = [...leaves];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(hash2(level[i], level[i + 1]));
      }
      level = next;
    }
    return level[0];
  };

  // --- poseidon.json ---
  const poseidonFixtures = {
    hash1: { input: ["42"], output: fieldStr(hash1(42n)) },
    hash2: { inputs: ["1", "2"], output: fieldStr(hash2(1n, 2n)) },
    commitment: {
      amount: "1000",
      label: "333",
      assetId: "1",
      nullifier: "111",
      secret: "222",
      output: fieldStr(await commitment(1000n, 333n, 111n, 222n, 1n)),
    },
  };
  fs.writeFileSync(
    path.join(TV, "poseidon.json"),
    JSON.stringify(poseidonFixtures, null, 2) + "\n"
  );

  // --- smt/empty-subtrees.json ---
  const EMPTY_SUBTREE = { 0: fieldStr(EMPTY_LEAF) };
  for (let d = 0; d < SMT_DEPTH; d++) {
    const child = BigInt(EMPTY_SUBTREE[d]);
    EMPTY_SUBTREE[d + 1] = fieldStr(hash2(child, child));
  }
  fs.writeFileSync(
    path.join(TV, "smt", "empty-subtrees.json"),
    JSON.stringify(
      {
        EMPTY_LEAF: fieldStr(EMPTY_LEAF),
        SMT_DEPTH,
        EMPTY_SUBTREE,
        EMPTY_REVOKED_ROOT: EMPTY_SUBTREE[SMT_DEPTH],
      },
      null,
      2
    ) + "\n"
  );

  // --- smt/smt-key-path.json ---
  // Raw labels share top 16 MSB bits; smtKey paths differ (hashed keys fix collision class).
  const labelA = 0xabcd000000000000000000000000000000000000000000000000000000000000n;
  const labelB = 0xabcdffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
  const keyA = smtKey(labelA);
  const keyB = smtKey(labelB);
  const msbPrefixBits = 16;
  const mask = (1n << BigInt(254 - msbPrefixBits)) - 1n;
  const prefixA = keyA >> BigInt(254 - msbPrefixBits);
  const prefixB = keyB >> BigInt(254 - msbPrefixBits);

  fs.writeFileSync(
    path.join(TV, "smt", "smt-key-path.json"),
    JSON.stringify(
      {
        _comment:
          "Demonstrates smtKey(label) paths; raw label MSB prefix may match while keys differ.",
        DOMAIN_SMT_KEY: domains.DOMAIN_SMT_KEY,
        labelA: fieldStr(labelA),
        labelB: fieldStr(labelB),
        rawLabelSharedMsbPrefixBits: msbPrefixBits,
        smtKeyA: fieldStr(keyA),
        smtKeyB: fieldStr(keyB),
        smtKeyDistinct: keyA !== keyB,
        pathBitA_level0: Number((keyA >> 253n) & 1n),
        pathBitB_level0: Number((keyB >> 253n) & 1n),
      },
      null,
      2
    ) + "\n"
  );

  // --- split-root.json ---
  const outLabel = 999n;
  const slices = [
    { value: "300", nullifier: "10", secret: "20" },
    { value: "700", nullifier: "11", secret: "21" },
    { value: "0", nullifier: "0", secret: "0" },
    { value: "0", nullifier: "0", secret: "0" },
    { value: "0", nullifier: "0", secret: "0" },
    { value: "0", nullifier: "0", secret: "0" },
    { value: "0", nullifier: "0", secret: "0" },
    { value: "0", nullifier: "0", secret: "0" },
  ];
  const outCommitments = [];
  for (const s of slices) {
    const v = BigInt(s.value);
    outCommitments.push(
      v === 0n
        ? 0n
        : await commitment(v, outLabel, BigInt(s.nullifier), BigInt(s.secret))
    );
  }
  const root = await splitRoot(outCommitments);
  fs.writeFileSync(
    path.join(TV, "split-root.json"),
    JSON.stringify(
      {
        outLabel: fieldStr(outLabel),
        slices,
        outCommitments: outCommitments.map(fieldStr),
        splitRoot: fieldStr(root),
      },
      null,
      2
    ) + "\n"
  );

  // --- chain-profile-evm.json ---
  const evmAddressToField = (hex20) => {
    const h = hex20.replace(/^0x/, "");
    const padded = h.padStart(64, "0");
    return BigInt("0x" + padded);
  };
  const chainId = 84532n;
  const vaultHex = "00000000000000000000000000000000000000a1";
  const payeeHex = "00000000000000000000000000000000000000b2";
  const vaultField = evmAddressToField(vaultHex);
  const payeeField = evmAddressToField(payeeHex);
  const vaultScopeId = hash3(DOMAIN_CHAIN_EVM, chainId, vaultField);
  const label = hash3(DOMAIN_VAULT_SCOPE, vaultScopeId, 7n);
  const payeeId = hash2(DOMAIN_PAYEE, payeeField);
  fs.writeFileSync(
    path.join(TV, "chain-profile-evm.json"),
    JSON.stringify(
      {
        profileId: "evm-v1",
        chainId: Number(chainId),
        vaultAddress: "0x" + vaultHex,
        vaultAddressBytes20: vaultHex,
        depositNonce: 7,
        payeeAddress: "0x" + payeeHex,
        payeeAddressBytes20: payeeHex,
        vaultScopeId: fieldStr(vaultScopeId),
        label: fieldStr(label),
        payeeId: fieldStr(payeeId),
      },
      null,
      2
    ) + "\n"
  );

  // --- public-encoding.json (layout reference) ---
  const publicFieldNames = [
    "action",
    "inputCount",
    "stateRoot",
    "admittedRoot",
    "revokedRoot",
    "primaryValue",
    "secondaryValue",
    "outCommitment",
    "outLabel",
    "nullifierHash0",
    "nullifierHash1",
    "nullifierHash2",
    "nullifierHash3",
    "nullifierHash4",
    "nullifierHash5",
    "payeeId",
    "programVersion",
    "mux17",
    "mux18",
    "mux19",
    "mux20",
    "mux21",
    "mux22",
    "mux23",
    "mux24",
  ];
  fs.writeFileSync(
    path.join(TV, "public-encoding.json"),
    JSON.stringify(
      {
        PUBLIC_WIDTH: 25,
        fieldNames: publicFieldNames,
        _muxSemantics: {
          merge: "public[5]=public[6]=0; amount lives in outCommitment only (3.4.1)",
          withdraw: "mux17 = assetId (D1)",
          swap: "indices 17-23: pool, dstToken, fee, minOut, outputPre, destC, srcAssetId (D1)",
          split: "mux17 = splitRoot",
          ragequit:
            "mux17 = claimant payeeId; mux18 = assetId; public[3]/[4] = current roots; public[8] = 0",
        },
      },
      null,
      2
    ) + "\n"
  );

  // --- ASP tree (MerkleTree.sol insert semantics) ---
  const pathIndicesFromLeafIndex = (index) => {
    const bits = [];
    const n = BigInt(index);
    for (let i = 0; i < 32; i++) {
      bits.push(Number((n >> BigInt(i)) & 1n));
    }
    return bits;
  };

  const aspPathAtIndex = (index, filledSubtrees, zeros) => {
    const pathElements = [];
    let currentIndex = BigInt(index);
    for (let i = 0; i < 32; i++) {
      pathElements.push(
        currentIndex % 2n === 0n ? zeros[i] : filledSubtrees[i]
      );
      currentIndex >>= 1n;
    }
    return {
      pathElements: pathElements.map(fieldStr),
      pathIndices: pathIndicesFromLeafIndex(index),
    };
  };

  const aspInsert = (filledSubtrees, zeros, leafCount, leaf) => {
    let currentIndex = BigInt(leafCount);
    let currentLevelHash = leaf;
    for (let i = 0; i < 32; i++) {
      if (currentIndex % 2n === 0n) {
        filledSubtrees[i] = currentLevelHash;
        currentLevelHash = hash2(currentLevelHash, zeros[i]);
      } else {
        currentLevelHash = hash2(filledSubtrees[i], currentLevelHash);
      }
      currentIndex >>= 1n;
    }
    return currentLevelHash;
  };

  const aspZeros = [];
  let az = 0n;
  for (let i = 0; i < 32; i++) {
    aspZeros[i] = az;
    az = hash2(az, az);
  }
  const aspEmptyRoot = az;
  fs.mkdirSync(path.join(TV, "asp"), { recursive: true });
  fs.writeFileSync(
    path.join(TV, "asp/empty-root.json"),
    JSON.stringify(
      {
        ADMIT_TREE_DEPTH: 32,
        emptyRoot: fieldStr(aspEmptyRoot),
        _pathIndexConvention: "leaf-level-0-is-lsb (MerkleTree.sol)",
      },
      null,
      2
    ) + "\n"
  );

  const aspFilled = [...aspZeros];
  const label0 = label;
  const label1 = hash3(DOMAIN_VAULT_SCOPE, vaultScopeId, 8n);
  const path0 = aspPathAtIndex(0, aspFilled, aspZeros);
  const root0 = aspInsert(aspFilled, aspZeros, 0, label0);
  const path1 = aspPathAtIndex(1, aspFilled, aspZeros);
  const root1 = aspInsert(aspFilled, aspZeros, 1, label1);

  fs.writeFileSync(
    path.join(TV, "asp/inclusion-path.json"),
    JSON.stringify(
      {
        _comment: "Two-label ASP sequence; paths verify against post-insert roots.",
        labels: [
          { leafIndex: 0, label: fieldStr(label0), root: fieldStr(root0), ...path0 },
          {
            leafIndex: 1,
            label: fieldStr(label1),
            root: fieldStr(root1),
            ...path1,
          },
        ],
      },
      null,
      2
    ) + "\n"
  );

  // --- smt/path-index-bind.json ---
  const smtPathBitsFromKey = (key) => {
    const bits = [];
    for (let j = 0; j < SMT_DEPTH; j++) {
      bits.push(Number((key >> BigInt(253 - j)) & 1n));
    }
    return bits;
  };
  const bindKey = smtKey(label0);
  fs.writeFileSync(
    path.join(TV, "smt/path-index-bind.json"),
    JSON.stringify(
      {
        label: fieldStr(label0),
        smtKey: fieldStr(bindKey),
        pathIndices: smtPathBitsFromKey(bindKey),
        _comment: "MSB-first: pathIndices[j] = bit j of smtKey (§2.5)",
      },
      null,
      2
    ) + "\n"
  );

  // --- journey / compliance policy fixtures (§5.1 / §5.2) ---
  const journey = (name, body) => ({ name, ...body });

  const journeyFixtures = [
    journey("ragequit-pending-not-admitted-ok", {
      action: "Ragequit",
      labelStatus: "Pending",
      labelInAsp: false,
      labelRevokedInSmt: false,
      admittedRootPublic: true,
      revokedRootPublic: true,
      expect: "ok",
    }),
    journey("ragequit-revoked-ok", {
      action: "Ragequit",
      labelStatus: "Revoked",
      labelInAsp: true,
      labelRevokedInSmt: true,
      admittedRootPublic: true,
      revokedRootPublic: true,
      expect: "ok",
    }),
    journey("ragequit-admitted-fail", {
      action: "Ragequit",
      labelStatus: "Admitted",
      labelInAsp: true,
      labelRevokedInSmt: false,
      admittedRootPublic: true,
      revokedRootPublic: true,
      expect: "fail",
      expectError: "RagequitWhileAdmitted",
    }),
    journey("withdraw-w3-not-admitted-fail", {
      action: "Withdraw",
      labelStatus: "Pending",
      labelInAsp: false,
      labelRevokedInSmt: false,
      admittedRootPublic: true,
      revokedRootPublic: true,
      expect: "fail",
      expectError: "NotAdmitted",
    }),
    journey("swap-destination-label-bind", {
      action: "Swap",
      publicOutLabel: "0",
      destLabel: fieldStr(label0),
      inLabel: fieldStr(label0),
      expectBind: true,
      mismatchLabel: fieldStr(label1),
      expectMismatch: false,
    }),
  ];

  for (const fx of journeyFixtures) {
    const { name, ...body } = fx;
    fs.writeFileSync(
      path.join(TV, `${name}.json`),
      JSON.stringify(body, null, 2) + "\n"
    );
  }

  // --- withdraw / merge witness fixtures (M0–M1 validate) ---
  const revokedPathStrings = (revokedLabels) =>
    revokedLabels.map((lbl) =>
      smtPathBitsFromKey(smtKey(lbl))
        .map((b) => String(b))
        .join("")
    );

  const hasRevokedUnder = (prefix, paths) =>
    paths.some((p) => p.startsWith(prefix));

  const smtGetNode = (
    prefix,
    revokedLabels,
    paths,
    emptySubtrees,
    cache
  ) => {
    if (cache.has(prefix)) return cache.get(prefix);
    if (!hasRevokedUnder(prefix, paths)) {
      const remaining = SMT_DEPTH - prefix.length;
      const v = BigInt(emptySubtrees[remaining]);
      cache.set(prefix, v);
      return v;
    }
    if (prefix.length === SMT_DEPTH) {
      for (let i = 0; i < paths.length; i++) {
        if (paths[i] === prefix) {
          const lh = leafHash(revokedLabels[i]);
          cache.set(prefix, lh);
          return lh;
        }
      }
      cache.set(prefix, EMPTY_LEAF);
      return EMPTY_LEAF;
    }
    const left = smtGetNode(
      prefix + "0",
      revokedLabels,
      paths,
      emptySubtrees,
      cache
    );
    const right = smtGetNode(
      prefix + "1",
      revokedLabels,
      paths,
      emptySubtrees,
      cache
    );
    const v = hash2(left, right);
    cache.set(prefix, v);
    return v;
  };

  const smtSiblingAtLevel = (
    level,
    bits,
    revokedLabels,
    paths,
    emptySubtrees,
    cache
  ) => {
    const prefixLen = SMT_DEPTH - level;
    let prefix = "";
    for (let i = 0; i < prefixLen - 1; i++) {
      prefix += String(bits[i]);
    }
    prefix += String(1 - bits[prefixLen - 1]);
    return smtGetNode(
      prefix,
      revokedLabels,
      paths,
      emptySubtrees,
      cache
    );
  };

  const smtRecomputeRoot = (bits, pathElements) => {
    let current = EMPTY_LEAF;
    for (let i = 0; i < SMT_DEPTH; i++) {
      const sibling = pathElements[i];
      current =
        bits[i] === 0 ? hash2(current, sibling) : hash2(sibling, current);
    }
    return current;
  };

  const smtPathElementsOld = (
    bits,
    revokedLabels,
    paths,
    emptySubtrees,
    cache
  ) => {
    const pathElements = [];
    for (let level = 0; level < SMT_DEPTH; level++) {
      pathElements.push(
        smtSiblingAtLevel(
          level,
          bits,
          revokedLabels,
          paths,
          emptySubtrees,
          cache
        )
      );
    }
    return pathElements;
  };

  const smtPathElementsRppFallback = (
    bits,
    revokedPath,
    root,
    revokedLabels,
    paths,
    emptySubtrees,
    cache
  ) => {
    for (let level = SMT_DEPTH - 1; level >= 0; level--) {
      const prefixLen = SMT_DEPTH - level;
      const rpPrefix = revokedPath.slice(0, prefixLen);
      const node = smtGetNode(
        rpPrefix,
        revokedLabels,
        paths,
        emptySubtrees,
        cache
      );
      if (node === BigInt(emptySubtrees[level])) {
        continue;
      }
      const pathElements = Array.from({ length: SMT_DEPTH }, (_, j) =>
        BigInt(emptySubtrees[j])
      );
      pathElements[level] = node;
      if (smtRecomputeRoot(bits, pathElements) === root) {
        return pathElements;
      }
    }
    return null;
  };

  const smtInclusionPath = (label, revokedLabels, emptySubtrees) => {
    if (revokedLabels.length !== 1 || BigInt(revokedLabels[0]) !== BigInt(label)) {
      throw new Error("smtInclusionPath: single-leaf revoked tree only");
    }
    const bits = smtPathBitsFromKey(smtKey(label));
    const root = smtRootAfterInsert(label, emptySubtrees);
    return {
      pathElements: Array.from({ length: SMT_DEPTH }, (_, j) => emptySubtrees[j]),
      pathIndices: bits,
      root: fieldStr(root),
    };
  };

  const smtRootAfterInsert = (label, emptySubtrees) => {
    const bits = smtPathBitsFromKey(smtKey(label));
    let current = leafHash(label);
    for (let level = 0; level < SMT_DEPTH; level++) {
      const emptySibling = BigInt(emptySubtrees[level]);
      current =
        bits[level] === 0
          ? hash2(current, emptySibling)
          : hash2(emptySibling, current);
    }
    return current;
  };

  const smtNonInclusionPath = (targetLabel, revokedLabels, emptySubtrees) => {
    const bits = smtPathBitsFromKey(smtKey(targetLabel));
    if (revokedLabels.length === 0) {
      return {
        pathElements: Array.from({ length: SMT_DEPTH }, (_, j) => emptySubtrees[j]),
        pathIndices: bits,
      };
    }
    const paths = revokedPathStrings(revokedLabels);
    const cache = new Map();
    const root = smtGetNode("", revokedLabels, paths, emptySubtrees, cache);
    const targetIsRevoked = revokedLabels.some(
      (lbl) => BigInt(lbl) === BigInt(targetLabel)
    );
    const oldPath = smtPathElementsOld(
      bits,
      revokedLabels,
      paths,
      emptySubtrees,
      cache
    );
    let pathElements = oldPath;
    if (!targetIsRevoked && smtRecomputeRoot(bits, oldPath) !== root) {
      for (const revokedPath of paths) {
        const fallback = smtPathElementsRppFallback(
          bits,
          revokedPath,
          root,
          revokedLabels,
          paths,
          emptySubtrees,
          cache
        );
        if (fallback) {
          pathElements = fallback;
          break;
        }
      }
    }
    return {
      pathElements: pathElements.map(fieldStr),
      pathIndices: bits,
    };
  };

  const smtRevokedTreeRoot = (revokedLabels, emptySubtrees) => {
    if (revokedLabels.length === 0) {
      return BigInt(emptySubtrees[SMT_DEPTH]);
    }
    const paths = revokedPathStrings(revokedLabels);
    return smtGetNode("", revokedLabels, paths, emptySubtrees, new Map());
  };

  const smtEmptyPath = (lbl) => smtNonInclusionPath(lbl, [], EMPTY_SUBTREE);

  const label2 = hash3(DOMAIN_VAULT_SCOPE, vaultScopeId, 9n);
  const w3Labels = [label, label1, label2];
  const w3Values = [400n, 350n, 250n];
  const w3Nullifiers = [101n, 102n, 103n];
  const w3Secrets = [201n, 202n, 203n];
  const w3Commitments = [];
  for (let i = 0; i < 3; i++) {
    w3Commitments.push(
      await commitment(w3Values[i], w3Labels[i], w3Nullifiers[i], w3Secrets[i])
    );
  }

  const merkleProofFromLeaves = (leafHashes, targetIndex, zeros) => {
    let idx = targetIndex;
    let currentLevel = leafHashes.map((h) => BigInt(h));
    const pathElements = [];
    const pathIndices = [];
    for (let d = 0; d < 32; d++) {
      pathIndices.push(idx & 1);
      const sibIdx = idx ^ 1;
      const sibling =
        sibIdx < currentLevel.length ? currentLevel[sibIdx] : zeros[d];
      pathElements.push(sibling);
      const next = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right =
          i + 1 < currentLevel.length ? currentLevel[i + 1] : zeros[d];
        next.push(hash2(left, right));
      }
      currentLevel = next.length ? next : [zeros[d + 1] ?? zeros[d]];
      idx = Math.floor(idx / 2);
    }
    return {
      pathElements: pathElements.map(fieldStr),
      pathIndices,
      root: fieldStr(currentLevel[0]),
    };
  };

  const buildMerklePaths = (leaves) => {
    const zeros = [...aspZeros];
    const rootProof = merkleProofFromLeaves(leaves, 0, zeros);
    const paths = [];
    for (let i = 0; i < leaves.length; i++) {
      paths.push(merkleProofFromLeaves(leaves, i, zeros));
    }
    return { root: rootProof.root, paths };
  };

  const stateBuilt = buildMerklePaths(w3Commitments);
  const aspBuilt = buildMerklePaths(w3Labels);
  const revokedEmptyRoot = EMPTY_SUBTREE[SMT_DEPTH];

  const boundaryIndex = 2;
  const primaryValue = 750n;
  const secondaryValue = 250n;
  const outNullifier = 999n;
  const outSecret = 888n;

  const buildInput = (i, labels, revokedLabels = []) => {
    const smtPath = smtNonInclusionPath(labels[i], revokedLabels, EMPTY_SUBTREE);
    return {
      inValue: fieldStr(w3Values[i]),
      inNullifier: fieldStr(w3Nullifiers[i]),
      inSecret: fieldStr(w3Secrets[i]),
      inLabel: fieldStr(labels[i]),
      inAssetId: fieldStr(DEFAULT_ASSET),
      admittedLeafIndex: i,
      statePathElements: stateBuilt.paths[i].pathElements,
      statePathIndices: stateBuilt.paths[i].pathIndices,
      admittedPathElements: aspBuilt.paths[i].pathElements,
      admittedPathIndices: aspBuilt.paths[i].pathIndices,
      revokedSmtPathElements: smtPath.pathElements,
      revokedSmtPathIndices: smtPath.pathIndices,
    };
  };

  const deriveExpectedPublic = async (w, labels, nullifiers) => {
    const nh = [];
    for (let i = 0; i < 6; i++) {
      nh.push(
        i < w.inputCount ? fieldStr(await hash1(nullifiers[i])) : "0"
      );
    }
    const outLabelWitness = fieldStr(labels[w.boundaryIndex]);
    let outCommitment = "0";
    let primaryLimb = w.primaryValue;
    let secondaryLimb = w.secondaryValue;

    if (w.action === 1) {
      primaryLimb = "0";
      secondaryLimb = "0";
      outCommitment = fieldStr(
        await commitment(
          w.primaryValue,
          outLabelWitness,
          w.outNullifier,
          w.outSecret
        )
      );
    } else if (w.action === 2) {
      if (BigInt(w.secondaryValue) !== 0n) {
        outCommitment = fieldStr(
          await commitment(
            w.secondaryValue,
            outLabelWitness,
            w.outNullifier,
            w.outSecret
          )
        );
      }
    } else if (w.action === 3) {
      primaryLimb = "0";
      secondaryLimb = "0";
      outCommitment = "0";
    } else if (w.action === 4) {
      secondaryLimb = "0";
      outCommitment = fieldStr(
        await commitment(
          w.primaryValue,
          outLabelWitness,
          w.outNullifier,
          w.outSecret
        )
      );
    } else if (BigInt(w.secondaryValue) !== 0n) {
      outCommitment = fieldStr(
        await commitment(
          w.secondaryValue,
          outLabelWitness,
          w.outNullifier,
          w.outSecret
        )
      );
    }

    const assetId = BigInt(w.inputs?.[0]?.inAssetId ?? DEFAULT_ASSET);
    let payeeLimb = "0";
    const mux = Array(8).fill("0");
    if (w.action === 0) {
      payeeLimb = fieldStr(payeeId);
      mux[0] = fieldStr(assetId);
    } else if (w.action === 2) {
      const allZeroPayee = w.rawPayeeHex.split("").every((c) => c === "0");
      payeeLimb = allZeroPayee ? "0" : fieldStr(payeeId);
      const destLabel =
        w.destLabel && w.destLabel !== "0" ? BigInt(w.destLabel) : BigInt(labels[0]);
      mux[0] = w.pool;
      mux[1] = w.dstToken;
      mux[2] = w.fee;
      mux[3] = w.minAmountOut;
      mux[4] = w.outputPrecommitment;
      mux[5] = fieldStr(
        await commitmentWithPre(
          w.minAmountOut,
          destLabel,
          w.outputPrecommitment,
          BigInt(w.dstToken)
        )
      );
      mux[6] = fieldStr(assetId);
    } else if (w.action === 3) {
      const outLabel = labels[0];
      const sliceCommitments = [];
      for (let i = 0; i < 8; i++) {
        const v = BigInt(w.splitValues[i]);
        if (v === 0n) {
          sliceCommitments.push(0n);
        } else {
          sliceCommitments.push(
            await commitment(
              w.splitValues[i],
              outLabel,
              w.splitNullifiers[i],
              w.splitSecrets[i]
            )
          );
        }
      }
      mux[0] = fieldStr(await splitRoot(sliceCommitments));
    } else if (w.action === 4) {
      mux[0] = fieldStr(payeeId);
      mux[1] = fieldStr(assetId);
    }

    return [
      String(w.action),
      String(w.inputCount),
      w.stateRoot,
      w.admittedRoot,
      w.revokedRoot,
      primaryLimb,
      secondaryLimb,
      outCommitment,
      "0",
      ...nh,
      payeeLimb,
      "3",
      ...mux,
    ];
  };

  const withdrawW3Base = {
    action: 0,
    inputCount: 3,
    boundaryIndex,
    stateRoot: fieldStr(stateBuilt.root),
    admittedRoot: fieldStr(aspBuilt.root),
    revokedRoot: fieldStr(revokedEmptyRoot),
    primaryValue: fieldStr(primaryValue),
    secondaryValue: fieldStr(secondaryValue),
    outNullifier: fieldStr(outNullifier),
    outSecret: fieldStr(outSecret),
    rawPayeeHex: payeeHex,
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    inputs: [0, 1, 2].map((i) => buildInput(i, w3Labels)),
  };

  const w3Ok = { ...withdrawW3Base };
  w3Ok.expectedPublic = await deriveExpectedPublic(
    w3Ok,
    w3Labels,
    w3Nullifiers
  );
  fs.writeFileSync(
    path.join(TV, "withdraw-w3-ok.json"),
    JSON.stringify(w3Ok, null, 2) + "\n"
  );

  const w3Zero = { ...withdrawW3Base };
  w3Zero.secondaryValue = "0";
  w3Zero.primaryValue = fieldStr(400n + 350n + 250n);
  w3Zero.expectedPublic = await deriveExpectedPublic(
    w3Zero,
    w3Labels,
    w3Nullifiers
  );
  fs.writeFileSync(
    path.join(TV, "withdraw-w3-zero-change-ok.json"),
    JSON.stringify(w3Zero, null, 2) + "\n"
  );

  const w3Revoked = JSON.parse(JSON.stringify(w3Ok));
  const w3RevokedLabel = w3Labels[1];
  const w3RevokedRoot = smtRevokedTreeRoot([w3RevokedLabel], EMPTY_SUBTREE);
  w3Revoked.revokedRoot = fieldStr(w3RevokedRoot);
  w3Revoked._comment =
    "Input 1 label is in revokedRoot; SMT non-inclusion fails for input 1.";
  for (let i = 0; i < 3; i++) {
    const smtPath = smtNonInclusionPath(
      w3Labels[i],
      [w3RevokedLabel],
      EMPTY_SUBTREE
    );
    w3Revoked.inputs[i].revokedSmtPathElements = smtPath.pathElements;
    w3Revoked.inputs[i].revokedSmtPathIndices = smtPath.pathIndices;
  }
  delete w3Revoked.expectedPublic;
  fs.writeFileSync(
    path.join(TV, "withdraw-w3-revoked-fail.json"),
    JSON.stringify(w3Revoked, null, 2) + "\n"
  );

  const smtDemoRevoked = 99999n;
  const smtDemoOther = 12345n;
  const smtDemoRoot = smtRevokedTreeRoot([smtDemoRevoked], EMPTY_SUBTREE);
  const smtDemoPath = smtNonInclusionPath(
    smtDemoOther,
    [smtDemoRevoked],
    EMPTY_SUBTREE
  );
  fs.writeFileSync(
    path.join(TV, "smt/revoked-non-inclusion.json"),
    JSON.stringify(
      {
        revokedLabel: fieldStr(smtDemoRevoked),
        targetLabel: fieldStr(smtDemoOther),
        revokedRoot: fieldStr(smtDemoRoot),
        pathElements: smtDemoPath.pathElements,
        pathIndices: smtDemoPath.pathIndices,
        _comment:
          "Non-inclusion path for test labels 12345 against revoked 99999",
      },
      null,
      2
    ) + "\n"
  );

  // --- merge-m2 witness (M1) ---
  const m2Labels = [w3Labels[0], w3Labels[1]];
  const m2Values = [400n, 350n];
  const m2Nullifiers = [101n, 102n];
  const m2Secrets = [201n, 202n];
  const m2Commitments = [];
  for (let i = 0; i < 2; i++) {
    m2Commitments.push(
      await commitment(m2Values[i], m2Labels[i], m2Nullifiers[i], m2Secrets[i])
    );
  }
  const m2State = buildMerklePaths(m2Commitments);
  const m2Asp = buildMerklePaths(m2Labels);
  const m2Boundary = 0;
  const m2Primary = 750n;
  const m2OutNullifier = 1001n;
  const m2OutSecret = 1002n;

  const buildM2Input = (i) => {
    const smtPath = smtEmptyPath(m2Labels[i]);
    return {
      inValue: fieldStr(m2Values[i]),
      inNullifier: fieldStr(m2Nullifiers[i]),
      inSecret: fieldStr(m2Secrets[i]),
      inLabel: fieldStr(m2Labels[i]),
      inAssetId: fieldStr(DEFAULT_ASSET),
      admittedLeafIndex: i,
      statePathElements: m2State.paths[i].pathElements,
      statePathIndices: m2State.paths[i].pathIndices,
      admittedPathElements: m2Asp.paths[i].pathElements,
      admittedPathIndices: m2Asp.paths[i].pathIndices,
      revokedSmtPathElements: smtPath.pathElements,
      revokedSmtPathIndices: smtPath.pathIndices,
    };
  };

  const mergeM2 = {
    action: 1,
    inputCount: 2,
    boundaryIndex: m2Boundary,
    stateRoot: fieldStr(m2State.root),
    admittedRoot: fieldStr(m2Asp.root),
    revokedRoot: fieldStr(revokedEmptyRoot),
    primaryValue: fieldStr(m2Primary),
    secondaryValue: "0",
    outNullifier: fieldStr(m2OutNullifier),
    outSecret: fieldStr(m2OutSecret),
    rawPayeeHex: "0000000000000000000000000000000000000000",
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    inputs: [0, 1].map((i) => buildM2Input(i)),
  };
  mergeM2.expectedPublic = await deriveExpectedPublic(
    mergeM2,
    m2Labels,
    m2Nullifiers
  );
  fs.writeFileSync(
    path.join(TV, "merge-m2-ok.json"),
    JSON.stringify(mergeM2, null, 2) + "\n"
  );

  // --- merge-m6 witness (M2 guest gate) ---
  const m6Labels = [
    ...w3Labels,
    hash3(DOMAIN_VAULT_SCOPE, vaultScopeId, 10n),
    hash3(DOMAIN_VAULT_SCOPE, vaultScopeId, 11n),
    hash3(DOMAIN_VAULT_SCOPE, vaultScopeId, 12n),
  ];
  const m6Values = [400n, 350n, 250n, 200n, 150n, 100n];
  const m6Nullifiers = [101n, 102n, 103n, 104n, 105n, 106n];
  const m6Secrets = [201n, 202n, 203n, 204n, 205n, 206n];
  const m6Commitments = [];
  for (let i = 0; i < 6; i++) {
    m6Commitments.push(
      await commitment(m6Values[i], m6Labels[i], m6Nullifiers[i], m6Secrets[i])
    );
  }
  const m6State = buildMerklePaths(m6Commitments);
  const m6Asp = buildMerklePaths(m6Labels);
  const m6Primary = m6Values.reduce((a, b) => a + b, 0n);
  const m6Boundary = 0;
  const m6OutNullifier = 2001n;
  const m6OutSecret = 2002n;

  const buildM6Input = (i) => {
    const smtPath = smtEmptyPath(m6Labels[i]);
    return {
      inValue: fieldStr(m6Values[i]),
      inNullifier: fieldStr(m6Nullifiers[i]),
      inSecret: fieldStr(m6Secrets[i]),
      inLabel: fieldStr(m6Labels[i]),
      inAssetId: fieldStr(DEFAULT_ASSET),
      admittedLeafIndex: i,
      statePathElements: m6State.paths[i].pathElements,
      statePathIndices: m6State.paths[i].pathIndices,
      admittedPathElements: m6Asp.paths[i].pathElements,
      admittedPathIndices: m6Asp.paths[i].pathIndices,
      revokedSmtPathElements: smtPath.pathElements,
      revokedSmtPathIndices: smtPath.pathIndices,
    };
  };

  const mergeM6 = {
    action: 1,
    inputCount: 6,
    boundaryIndex: m6Boundary,
    stateRoot: fieldStr(m6State.root),
    admittedRoot: fieldStr(m6Asp.root),
    revokedRoot: fieldStr(revokedEmptyRoot),
    primaryValue: fieldStr(m6Primary),
    secondaryValue: "0",
    outNullifier: fieldStr(m6OutNullifier),
    outSecret: fieldStr(m6OutSecret),
    rawPayeeHex: "0000000000000000000000000000000000000000",
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    inputs: [0, 1, 2, 3, 4, 5].map((i) => buildM6Input(i)),
  };
  mergeM6.expectedPublic = await deriveExpectedPublic(
    mergeM6,
    m6Labels,
    m6Nullifiers
  );
  fs.writeFileSync(
    path.join(TV, "merge-m6-ok.json"),
    JSON.stringify(mergeM6, null, 2) + "\n"
  );

  // --- ragequit witness fixtures (§5.2) ---
  const rqNullifier = 501n;
  const rqSecret = 502n;
  const rqDepositorHex = payeeHex;

  const rqPendingCommit = await commitment(
    400n,
    label0,
    rqNullifier,
    rqSecret
  );
  const rqPendingState = buildMerklePaths([rqPendingCommit]);
  const rqPendingAspPath = aspPathAtIndex(0, [...aspZeros], aspZeros);
  const rqPendingSmt = smtEmptyPath(label0);

  const ragequitPending = {
    action: 4,
    inputCount: 1,
    boundaryIndex: 0,
    ragequitBranch: 0,
    stateRoot: fieldStr(rqPendingState.root),
    admittedRoot: fieldStr(aspEmptyRoot),
    revokedRoot: fieldStr(revokedEmptyRoot),
    primaryValue: "400",
    secondaryValue: "0",
    outNullifier: fieldStr(rqNullifier),
    outSecret: fieldStr(rqSecret),
    rawPayeeHex: rqDepositorHex,
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    inputs: [
      {
        inValue: "400",
        inNullifier: fieldStr(rqNullifier),
        inSecret: fieldStr(rqSecret),
        inLabel: fieldStr(label0),
        inAssetId: fieldStr(DEFAULT_ASSET),
        admittedLeafIndex: 0,
        statePathElements: rqPendingState.paths[0].pathElements,
        statePathIndices: rqPendingState.paths[0].pathIndices,
        admittedPathElements: rqPendingAspPath.pathElements,
        admittedPathIndices: rqPendingAspPath.pathIndices,
        revokedSmtPathElements: rqPendingSmt.pathElements,
        revokedSmtPathIndices: rqPendingSmt.pathIndices,
      },
    ],
  };
  ragequitPending.expectedPublic = await deriveExpectedPublic(
    ragequitPending,
    [label0],
    [rqNullifier]
  );
  fs.writeFileSync(
    path.join(TV, "ragequit-pending-witness-ok.json"),
    JSON.stringify(ragequitPending, null, 2) + "\n"
  );

  const rqRevNullifier = 601n;
  const rqRevSecret = 602n;
  const rqRevCommit = await commitment(
    350n,
    label1,
    rqRevNullifier,
    rqRevSecret
  );
  const rqRevState = buildMerklePaths([rqRevCommit]);
  const rqRevokedRoot = smtRootAfterInsert(label1, EMPTY_SUBTREE);
  const rqRevSmt = smtInclusionPath(label1, [label1], EMPTY_SUBTREE);

  const ragequitRevoked = {
    action: 4,
    inputCount: 1,
    boundaryIndex: 0,
    ragequitBranch: 1,
    stateRoot: fieldStr(rqRevState.root),
    admittedRoot: fieldStr(root1),
    revokedRoot: fieldStr(rqRevokedRoot),
    primaryValue: "350",
    secondaryValue: "0",
    outNullifier: fieldStr(rqRevNullifier),
    outSecret: fieldStr(rqRevSecret),
    rawPayeeHex: rqDepositorHex,
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    inputs: [
      {
        inValue: "350",
        inNullifier: fieldStr(rqRevNullifier),
        inSecret: fieldStr(rqRevSecret),
        inLabel: fieldStr(label1),
        inAssetId: fieldStr(DEFAULT_ASSET),
        admittedLeafIndex: 1,
        statePathElements: rqRevState.paths[0].pathElements,
        statePathIndices: rqRevState.paths[0].pathIndices,
        admittedPathElements: path1.pathElements,
        admittedPathIndices: path1.pathIndices,
        revokedSmtPathElements: rqRevSmt.pathElements,
        revokedSmtPathIndices: rqRevSmt.pathIndices,
      },
    ],
  };
  ragequitRevoked.expectedPublic = await deriveExpectedPublic(
    ragequitRevoked,
    [label1],
    [rqRevNullifier]
  );
  fs.writeFileSync(
    path.join(TV, "ragequit-revoked-witness-ok.json"),
    JSON.stringify(ragequitRevoked, null, 2) + "\n"
  );

  const ragequitAdmitted = JSON.parse(JSON.stringify(ragequitPending));
  ragequitAdmitted.admittedRoot = fieldStr(root0);
  ragequitAdmitted.inputs[0].admittedPathElements = path0.pathElements;
  ragequitAdmitted.inputs[0].admittedPathIndices = path0.pathIndices;
  delete ragequitAdmitted.expectedPublic;
  fs.writeFileSync(
    path.join(TV, "ragequit-admitted-witness-fail.json"),
    JSON.stringify(ragequitAdmitted, null, 2) + "\n"
  );

  // --- swap witness (M5) ---
  const swapLabel = w3Labels[0];
  const swapValue = 400n;
  const swapNullifier = 301n;
  const swapSecret = 302n;
  const swapCommit = await commitment(
    swapValue,
    swapLabel,
    swapNullifier,
    swapSecret
  );
  const swapState = buildMerklePaths([swapCommit]);
  const swapAsp = buildMerklePaths([swapLabel]);
  const swapPrimary = 300n;
  const swapSecondary = swapValue - swapPrimary;
  const swapChangeNullifier = 303n;
  const swapChangeSecret = 304n;
  const swapDestNullifier = 305n;
  const swapDestSecret = 306n;
  const swapOutputPre = hash2(swapDestNullifier, swapDestSecret);
  const swapPool = 0x1111111111111111111111111111111111111111n;
  const swapDstToken = 0x2222222222222222222222222222222222222222n;
  const swapFee = 3000n;
  const swapMinOut = 250n;

  const swapOk = {
    action: 2,
    inputCount: 1,
    boundaryIndex: 0,
    stateRoot: fieldStr(swapState.root),
    admittedRoot: fieldStr(swapAsp.root),
    revokedRoot: fieldStr(revokedEmptyRoot),
    primaryValue: fieldStr(swapPrimary),
    secondaryValue: fieldStr(swapSecondary),
    outNullifier: fieldStr(swapChangeNullifier),
    outSecret: fieldStr(swapChangeSecret),
    rawPayeeHex: "0000000000000000000000000000000000000000",
    pool: fieldStr(swapPool),
    dstToken: fieldStr(swapDstToken),
    fee: fieldStr(swapFee),
    minAmountOut: fieldStr(swapMinOut),
    outputPrecommitment: fieldStr(swapOutputPre),
    destNullifier: fieldStr(swapDestNullifier),
    destSecret: fieldStr(swapDestSecret),
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    inputs: [
      {
        inValue: fieldStr(swapValue),
        inNullifier: fieldStr(swapNullifier),
        inSecret: fieldStr(swapSecret),
        inLabel: fieldStr(swapLabel),
        inAssetId: fieldStr(DEFAULT_ASSET),
        admittedLeafIndex: 0,
        statePathElements: swapState.paths[0].pathElements,
        statePathIndices: swapState.paths[0].pathIndices,
        admittedPathElements: swapAsp.paths[0].pathElements,
        admittedPathIndices: swapAsp.paths[0].pathIndices,
        revokedSmtPathElements: smtEmptyPath(swapLabel).pathElements,
        revokedSmtPathIndices: smtEmptyPath(swapLabel).pathIndices,
      },
    ],
  };
  swapOk.expectedPublic = await deriveExpectedPublic(
    swapOk,
    [swapLabel],
    [swapNullifier]
  );
  fs.writeFileSync(
    path.join(TV, "swap-ok.json"),
    JSON.stringify(swapOk, null, 2) + "\n"
  );

  const swapPreFail = JSON.parse(JSON.stringify(swapOk));
  swapPreFail.outputPrecommitment = fieldStr(swapOutputPre + 1n);
  delete swapPreFail.expectedPublic;
  fs.writeFileSync(
    path.join(TV, "swap-output-precommitment-fail.json"),
    JSON.stringify(swapPreFail, null, 2) + "\n"
  );

  const swapDestLabelFail = JSON.parse(JSON.stringify(swapOk));
  swapDestLabelFail.destLabel = fieldStr(w3Labels[1]);
  delete swapDestLabelFail.expectedPublic;
  fs.writeFileSync(
    path.join(TV, "swap-dest-label-fail.json"),
    JSON.stringify(swapDestLabelFail, null, 2) + "\n"
  );

  const swapDestBind = {
    action: "Swap",
    destCommitment: swapOk.expectedPublic[22],
    minAmountOut: swapOk.minAmountOut,
    outputPrecommitment: swapOk.outputPrecommitment,
    inLabel: fieldStr(swapLabel),
    destLabel: fieldStr(swapLabel),
    expectBind: true,
  };
  fs.writeFileSync(
    path.join(TV, "swap-destination-bind.json"),
    JSON.stringify(swapDestBind, null, 2) + "\n"
  );

  // --- split witness (M5) ---
  const splitLabel = label0;
  const splitInValue = 1000n;
  const splitInNullifier = 401n;
  const splitInSecret = 402n;
  const splitValues = [
    "300",
    "700",
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
  ];
  const splitNullifiers = [
    fieldStr(10n),
    fieldStr(11n),
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
  ];
  const splitSecrets = [
    fieldStr(20n),
    fieldStr(21n),
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
  ];
  const splitInCommit = await commitment(
    splitInValue,
    splitLabel,
    splitInNullifier,
    splitInSecret
  );
  const splitState = buildMerklePaths([splitInCommit]);
  const splitAsp = buildMerklePaths([splitLabel]);
  const splitSliceCommitments = [];
  for (let i = 0; i < 8; i++) {
    if (BigInt(splitValues[i]) === 0n) {
      splitSliceCommitments.push(0n);
    } else {
      splitSliceCommitments.push(
        await commitment(
          splitValues[i],
          splitLabel,
          splitNullifiers[i],
          splitSecrets[i]
        )
      );
    }
  }
  const splitRootVal = await splitRoot(splitSliceCommitments);

  const splitOk = {
    action: 3,
    inputCount: 1,
    boundaryIndex: 0,
    stateRoot: fieldStr(splitState.root),
    admittedRoot: fieldStr(splitAsp.root),
    revokedRoot: fieldStr(revokedEmptyRoot),
    primaryValue: "0",
    secondaryValue: "0",
    outNullifier: "0",
    outSecret: "0",
    rawPayeeHex: "0000000000000000000000000000000000000000",
    splitValues,
    splitNullifiers,
    splitSecrets,
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    inputs: [
      {
        inValue: fieldStr(splitInValue),
        inNullifier: fieldStr(splitInNullifier),
        inSecret: fieldStr(splitInSecret),
        inLabel: fieldStr(splitLabel),
        inAssetId: fieldStr(DEFAULT_ASSET),
        admittedLeafIndex: 0,
        statePathElements: splitState.paths[0].pathElements,
        statePathIndices: splitState.paths[0].pathIndices,
        admittedPathElements: splitAsp.paths[0].pathElements,
        admittedPathIndices: splitAsp.paths[0].pathIndices,
        revokedSmtPathElements: smtEmptyPath(splitLabel).pathElements,
        revokedSmtPathIndices: smtEmptyPath(splitLabel).pathIndices,
      },
    ],
  };
  splitOk.expectedPublic = await deriveExpectedPublic(
    splitOk,
    [splitLabel],
    [splitInNullifier]
  );
  fs.writeFileSync(
    path.join(TV, "split-ok.json"),
    JSON.stringify(splitOk, null, 2) + "\n"
  );

  const splitCalldataMismatch = {
    splitRoot: fieldStr(splitRootVal),
    sliceCommitments: splitSliceCommitments.map(fieldStr),
    tamperedIndex: 1,
    tamperedCommitment: fieldStr(splitSliceCommitments[1] + 1n),
    _comment: "Vault rejects when extra.splitCommitments[i] != guest slice",
  };
  fs.writeFileSync(
    path.join(TV, "split-calldata-mismatch.json"),
    JSON.stringify(splitCalldataMismatch, null, 2) + "\n"
  );

  // --- deposit witness (§2.7) ---
  const depositSalt = 4242n;
  const depositNullifier = 501n;
  const depositSecret = 502n;
  const depositNonce = 7n;
  const depositAmount = 1000n;
  const depositLabel = hash2(
    hash3(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce),
    depositSalt
  );
  const depositCommitment = await commitment(
    depositAmount,
    depositLabel,
    depositNullifier,
    depositSecret
  );

  const depositOk = {
    measuredAmount: fieldStr(depositAmount),
    claimedAmount: fieldStr(depositAmount),
    userSalt: fieldStr(depositSalt),
    assetId: fieldStr(DEFAULT_ASSET),
    nullifier: fieldStr(depositNullifier),
    secret: fieldStr(depositSecret),
    depositNonce: Number(depositNonce),
    vaultScopeId: fieldStr(vaultScopeId),
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    expectedLabel: fieldStr(depositLabel),
    expectedCommitment: fieldStr(depositCommitment),
    expectedPublic: [
      fieldStr(depositAmount),
      fieldStr(depositCommitment),
      String(depositNonce),
      fieldStr(vaultScopeId),
      "3",
    ],
  };
  fs.writeFileSync(
    path.join(TV, "deposit-ok.json"),
    JSON.stringify(depositOk, null, 2) + "\n"
  );

  const depositFakeAmount = {
    ...depositOk,
    claimedAmount: fieldStr(depositAmount + 999n),
  };
  delete depositFakeAmount.expectedPublic;
  delete depositFakeAmount.expectedLabel;
  delete depositFakeAmount.expectedCommitment;
  fs.writeFileSync(
    path.join(TV, "deposit-fake-amount-fail.json"),
    JSON.stringify(depositFakeAmount, null, 2) + "\n"
  );

  const depositZeroSalt = { ...depositOk, userSalt: "0" };
  delete depositZeroSalt.expectedPublic;
  delete depositZeroSalt.expectedLabel;
  delete depositZeroSalt.expectedCommitment;
  fs.writeFileSync(
    path.join(TV, "deposit-zero-salt-fail.json"),
    JSON.stringify(depositZeroSalt, null, 2) + "\n"
  );

  const depositBorrow = {
    ...depositOk,
    userSuppliedLabel: fieldStr(label1),
  };
  delete depositBorrow.expectedPublic;
  delete depositBorrow.expectedLabel;
  delete depositBorrow.expectedCommitment;
  fs.writeFileSync(
    path.join(TV, "deposit-borrow-label-fail.json"),
    JSON.stringify(depositBorrow, null, 2) + "\n"
  );

  // --- deposit → ragequit journey (Pending: not in ASP) ---
  const depState = buildMerklePaths([depositCommitment]);
  const depAspEmpty = aspPathAtIndex(0, [...aspZeros], aspZeros);
  const depSmt = smtEmptyPath(depositLabel);
  const depositJourneyRagequit = {
    action: 4,
    inputCount: 1,
    boundaryIndex: 0,
    stateRoot: fieldStr(depState.root),
    admittedRoot: fieldStr(aspEmptyRoot),
    revokedRoot: fieldStr(revokedEmptyRoot),
    primaryValue: fieldStr(depositAmount),
    secondaryValue: "0",
    outNullifier: fieldStr(depositNullifier),
    outSecret: fieldStr(depositSecret),
    rawPayeeHex: payeeHex,
    chainProfile: "evm-v1",
    chainId: Number(chainId),
    _depositSource: "deposit-ok.json",
    inputs: [
      {
        inValue: fieldStr(depositAmount),
        inNullifier: fieldStr(depositNullifier),
        inSecret: fieldStr(depositSecret),
        inLabel: fieldStr(depositLabel),
        inAssetId: fieldStr(DEFAULT_ASSET),
        admittedLeafIndex: 0,
        statePathElements: depState.paths[0].pathElements,
        statePathIndices: depState.paths[0].pathIndices,
        admittedPathElements: depAspEmpty.pathElements,
        admittedPathIndices: depAspEmpty.pathIndices,
        revokedSmtPathElements: depSmt.pathElements,
        revokedSmtPathIndices: depSmt.pathIndices,
      },
    ],
  };
  depositJourneyRagequit.expectedPublic = await deriveExpectedPublic(
    depositJourneyRagequit,
    [depositLabel],
    [depositNullifier]
  );
  fs.writeFileSync(
    path.join(TV, "deposit-journey-ragequit-ok.json"),
    JSON.stringify(depositJourneyRagequit, null, 2) + "\n"
  );

  const w3Mismatch = { ...w3Ok };
  w3Mismatch.submittedPublic = [...w3Ok.expectedPublic];
  w3Mismatch.submittedPublic[5] = fieldStr(primaryValue + 1n);
  w3Mismatch._comment = "submittedPublic[5] != derived primaryValue";
  fs.writeFileSync(
    path.join(TV, "witness-public-mismatch.json"),
    JSON.stringify(w3Mismatch, null, 2) + "\n"
  );

  console.log("Exported test vectors to", TV);
}

fs.mkdirSync(path.join(TV, "smt"), { recursive: true });
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

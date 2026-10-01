/**
 * Probe which (programVersion, labelCommit) shape the local withdraw1 zkey accepts.
 *   cd siphon-app && node ../siphon-contracts-v2/solana/scripts/probe-withdraw1-shape.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../../siphon-app");
const zkRoot = path.resolve(here, "../../../siphon-zk-v2");
const snarkjs = require(path.join(app, "node_modules/snarkjs"));
const { buildPoseidon } = require(path.join(app, "node_modules/circomlibjs"));

const EMPTY = JSON.parse(
  fs.readFileSync(path.join(zkRoot, "test-vectors/smt/empty-subtrees.json"), "utf8"),
);
const WASM = path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/main_withdraw1.wasm");
const ZKEY = path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/zkey_final.zkey");
const VKEY = JSON.parse(
  fs.readFileSync(path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/verification_key.json"), "utf8"),
);

const poseidon = await buildPoseidon();
const hash = (xs) => BigInt(poseidon.F.toObject(poseidon(xs.map(BigInt))));

async function oneLeaf(leaf) {
  const pe = [];
  const pi = [];
  let zero = 0n;
  let root = BigInt(leaf);
  for (let l = 0; l < 32; l++) {
    pe.push(zero);
    pi.push(0);
    root = await hash([root, zero]);
    zero = await hash([zero, zero]);
  }
  return { root, pe, pi };
}

function emptySmt(key) {
  const pe = [];
  for (let i = 0; i < 32; i++) pe.push(EMPTY.EMPTY_SUBTREE[String(i)]);
  const bits = [];
  const k = BigInt(key);
  for (let j = 0; j < 32; j++) bits.push(Number((k >> (253n - BigInt(j))) & 1n));
  return { pe, bits, root: EMPTY.EMPTY_REVOKED_ROOT };
}

async function labelCommit(n, labels, salt) {
  const padded = Array.from({ length: 6 }, (_, i) => labels[i] ?? 0n);
  return hash([7n, BigInt(n), ...padded, salt]);
}

const inValue = 10_000_000n;
const inLabel = 123456789n;
const inAssetId = 4096n;
const inN = 111111n;
const inS = 222222n;
const leaf = await hash([await hash([inValue, inLabel, inAssetId]), await hash([inN, inS])]);
const state = await oneLeaf(leaf);
const asp = await oneLeaf(inLabel);
const smt = emptySmt(await hash([1n, inLabel]));
const nh = await hash([inN]);
const payee = Array.from({ length: 20 }, (_, i) => i + 1);
let pf = 0n;
for (let i = 0; i < 20; i++) pf += BigInt(payee[i]) << BigInt(8 * (19 - i));
const payeeId = await hash([4n, pf]);
const salt = 12345n;
const lc = await labelCommit(1, [inLabel], salt);

async function tryCase(name, ver, limb24, withSalt) {
  const publicInputs = [
    "0",
    "1",
    state.root.toString(),
    asp.root.toString(),
    smt.root,
    "10000000",
    "0",
    "0",
    "0",
    nh.toString(),
    "0",
    "0",
    "0",
    "0",
    "0",
    payeeId.toString(),
    String(ver),
    inAssetId.toString(),
    "0",
    "0",
    "0",
    "0",
    "0",
    "0",
    limb24.toString(),
  ];
  const input = {
    publicInputs,
    boundaryIndex: "0",
    inValue: [String(inValue)],
    inNullifier: [String(inN)],
    inSecret: [String(inS)],
    inLabel: [String(inLabel)],
    inAssetId: [String(inAssetId)],
    statePathElements: [state.pe.map(String)],
    statePathIndices: [state.pi],
    admittedLeafIndex: ["0"],
    admittedPathElements: [asp.pe.map(String)],
    admittedPathIndices: [asp.pi],
    revokedSmtPathElements: [smt.pe],
    revokedSmtPathIndices: [smt.bits],
    revokedSmtLeaf: ["0"],
    outNullifier: "333",
    outSecret: "444",
    rawPayee: payee,
  };
  if (withSalt) input.labelCommitSalt = String(salt);
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const ok = await snarkjs.groth16.verify(VKEY, publicSignals, proof);
    console.log(`OK ${name} verify=${ok}`);
  } catch (e) {
    console.log(`FAIL ${name} :: ${String(e.message || e).slice(0, 180)}`);
  }
}

console.log("wasm", WASM);
console.log("zkey bytes", fs.statSync(ZKEY).size);
await tryCase("v4 limb24=0 noSalt", 4, 0n, false);
await tryCase("v4 limb24=0 +salt", 4, 0n, true);
await tryCase("v5 limb24=lc +salt", 5, lc, true);
await tryCase("v5 limb24=0 +salt", 5, 0n, true);
await tryCase("v4 limb24=lc +salt", 4, lc, true);

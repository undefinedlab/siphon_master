/**
 * Dump withdraw1 proof/publics/VK fixtures for host cargo test.
 *   cd siphon-app
 *   node ../siphon-contracts-v2/solana/scripts/host-verify-withdraw1.mjs
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

const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FQ =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const EMPTY = JSON.parse(
  fs.readFileSync(path.join(zkRoot, "test-vectors/smt/empty-subtrees.json"), "utf8"),
);
const WASM = path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/main_withdraw1.wasm");
const ZKEY = path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/zkey_final.zkey");
const VKEY = JSON.parse(
  fs.readFileSync(path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/verification_key.json"), "utf8"),
);
const OUT = path.join(here, "../target/deploy/host-verify-fixtures");

const poseidon = await buildPoseidon();
const hash = (xs) => BigInt(poseidon.F.toObject(poseidon(xs.map(BigInt))));

function modFr(x) {
  const r = BigInt(x) % FIELD;
  return r < 0n ? r + FIELD : r;
}
function toBe32Fq(n) {
  let x = BigInt(n) % FQ;
  if (x < 0n) x += FQ;
  return Buffer.from(x.toString(16).padStart(64, "0"), "hex");
}
function fieldToLe32(x) {
  const b = Buffer.alloc(32);
  let v = modFr(x);
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function g1(pt) {
  const out = Buffer.alloc(64);
  toBe32Fq(pt[0]).copy(out, 0);
  toBe32Fq(pt[1]).copy(out, 32);
  return out;
}
function g2(pt, c1First) {
  const out = Buffer.alloc(128);
  if (c1First) {
    toBe32Fq(pt[0][1]).copy(out, 0);
    toBe32Fq(pt[0][0]).copy(out, 32);
    toBe32Fq(pt[1][1]).copy(out, 64);
    toBe32Fq(pt[1][0]).copy(out, 96);
  } else {
    toBe32Fq(pt[0][0]).copy(out, 0);
    toBe32Fq(pt[0][1]).copy(out, 32);
    toBe32Fq(pt[1][0]).copy(out, 64);
    toBe32Fq(pt[1][1]).copy(out, 96);
  }
  return out;
}
function packVk(vkJson, c1First) {
  const alpha = g1(vkJson.vk_alpha_1);
  const beta = g2(vkJson.vk_beta_2, c1First);
  const gamma = g2(vkJson.vk_gamma_2, c1First);
  const delta = g2(vkJson.vk_delta_2, c1First);
  const ic = (vkJson.IC || []).map(g1);
  const raw = Buffer.alloc(8 + 64 + 128 + 128 + 128 + 26 * 64);
  raw.writeBigUInt64LE(25n, 0);
  alpha.copy(raw, 8);
  beta.copy(raw, 72);
  gamma.copy(raw, 200);
  delta.copy(raw, 328);
  for (let i = 0; i < 26; i++) ic[i].copy(raw, 456 + i * 64);
  return raw;
}
function packProof(proof, c1First) {
  const be = toBe32Fq;
  const g2p = (p) =>
    c1First ? Buffer.concat([be(p[1]), be(p[0])]) : Buffer.concat([be(p[0]), be(p[1])]);
  return Buffer.concat([
    be(proof.pi_a[0]),
    be(proof.pi_a[1]),
    g2p(proof.pi_b[0]),
    g2p(proof.pi_b[1]),
    be(proof.pi_c[0]),
    be(proof.pi_c[1]),
  ]);
}

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
  "5",
  inAssetId.toString(),
  "0",
  "0",
  "0",
  "0",
  "0",
  "0",
  lc.toString(),
];
const input = {
  publicInputs,
  boundaryIndex: "0",
  inValue: [inValue.toString()],
  inNullifier: [inN.toString()],
  inSecret: [inS.toString()],
  inLabel: [inLabel.toString()],
  inAssetId: [inAssetId.toString()],
  statePathElements: [state.pe.map(String)],
  statePathIndices: [state.pi],
  admittedLeafIndex: ["0"],
  admittedPathElements: [asp.pe.map(String)],
  admittedPathIndices: [asp.pi],
  revokedSmtPathElements: [smt.pe],
  revokedSmtPathIndices: [smt.bits],
  revokedSmtLeaf: ["0"],
  outNullifier: "333333",
  outSecret: "444444",
  rawPayee: payee,
  labelCommitSalt: salt.toString(),
};

console.log("proving…");
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
if (!(await snarkjs.groth16.verify(VKEY, publicSignals, proof))) throw new Error("snarkjs verify failed");

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "vk.c1.bin"), packVk(VKEY, true));
fs.writeFileSync(path.join(OUT, "vk.c0.bin"), packVk(VKEY, false));
fs.writeFileSync(path.join(OUT, "proof.c1.bin"), packProof(proof, true));
fs.writeFileSync(path.join(OUT, "proof.c0.bin"), packProof(proof, false));
fs.writeFileSync(
  path.join(OUT, "publics.le.bin"),
  Buffer.concat(publicSignals.map((p) => fieldToLe32(p))),
);
console.log("ok →", OUT);

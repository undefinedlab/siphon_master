/**
 * Devnet E2E through the deployed stack — the product path, not an authority shortcut:
 *
 *   ASP /screen (depositor + commitment + userSalt)
 *   → deposit (WSOL) on siphon-vault-zk
 *   → siphon-solasp watcher indexes the DepositEvent and admits the label
 *   → postman publishes (admitted, revoked) via publish_roots
 *   → leaves from /solana/state/leaves, ASP + SMT paths from /set/path, /set/smt-path
 *   → withdraw1 proof with the MPC ceremony zkey → commit_public_inputs → spend
 *
 * Never calls set_compliance: the roots on chain are whatever the postman published, exactly as
 * for a real user. On-chain VKs must be the ceremony set (scripts/upload-vk-devnet.mjs with
 * VK_DIR=target/deploy/vk-ceremony).
 *
 * Env:
 *   SOLASP_URL            default https://api.siphon.money/solasp
 *   SOLASP_SCREEN_TOKEN   siphon-solasp ASP_SCREEN_TOKEN (required)
 *   ZK_ART_DIR            dir holding withdraw1/{withdraw1.wasm,zkey_final.zkey,verification_key.json}
 *   SOLANA_RPC_URL        default https://api.devnet.solana.com
 *
 *   cd siphon-app && node ../siphon-contracts-v2/solana/scripts/e2e-devnet-zk-asp.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../../siphon-app");
const require = createRequire(import.meta.url);
const web3 = require(path.join(app, "node_modules/@solana/web3.js/lib/index.cjs.js"));
const spl = require(path.join(app, "node_modules/@solana/spl-token"));
const snarkjs = require(path.join(app, "node_modules/snarkjs"));
const { buildPoseidon } = require(path.join(app, "node_modules/circomlibjs"));

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = web3;
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} = spl;

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID || "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH",
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ASP = (process.env.SOLASP_URL || "https://api.siphon.money/solasp").replace(/\/$/, "");
const ASP_TOKEN = process.env.SOLASP_SCREEN_TOKEN || "";
const ART = process.env.ZK_ART_DIR || "";
const CHAIN_ID = 900002;
const AMOUNT = BigInt(process.env.AMOUNT_LAMPORTS || "5000000");
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const DOMAIN_VAULT_SCOPE = 3n;
const DOMAIN_CHAIN_SOL = 6n;
const DOMAIN_PAYEE = 4n;
const DOMAIN_LABEL_COMMIT = 7n;
const PROGRAM_VERSION = 5;

if (!ASP_TOKEN) throw new Error("SOLASP_SCREEN_TOKEN required");
const WASM = path.join(ART, "withdraw1", "withdraw1.wasm");
const ZKEY = path.join(ART, "withdraw1", "zkey_final.zkey");
const VKEY_PATH = path.join(ART, "withdraw1", "verification_key.json");
for (const f of [WASM, ZKEY, VKEY_PATH]) if (!fs.existsSync(f)) throw new Error(`missing ${f} (set ZK_ART_DIR)`);
const VKEY = JSON.parse(fs.readFileSync(VKEY_PATH, "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
const modField = (x) => ((x % FIELD) + FIELD) % FIELD;
function fieldFromBe32(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return modField(v);
}
function fieldToLe32(x) {
  const b = Buffer.alloc(32);
  let v = modField(BigInt(x));
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function le32ToField(b) {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return modField(v);
}
const bigToBe32Fq = (n) => Buffer.from((((BigInt(n) % FQ) + FQ) % FQ).toString(16).padStart(64, "0"), "hex");
function randomLimb() {
  const b = Buffer.concat([randomBytes(31), Buffer.from([0])]);
  let v = 0n;
  for (let i = 0; i < 32; i++) v |= BigInt(b[i]) << BigInt(8 * i);
  return v === 0n ? 1n : modField(v);
}

const poseidon = await buildPoseidon();
const hashN = (xs) => BigInt(poseidon.F.toObject(poseidon(xs.map((x) => modField(BigInt(x))))));

async function buildStatePath(leaves, leafIndex) {
  const zeros = [0n];
  for (let i = 1; i <= 32; i++) zeros[i] = hashN([zeros[i - 1], zeros[i - 1]]);
  const pe = [];
  const pi = [];
  let level = leaves.slice();
  let idx = leafIndex;
  for (let d = 0; d < 32; d++) {
    const isRight = idx & 1;
    const sib = isRight ? idx - 1 : idx + 1;
    pe.push(sib < level.length ? level[sib] : zeros[d]);
    pi.push(isRight);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashN([level[i], i + 1 < level.length ? level[i + 1] : zeros[d]]));
    level = next.length ? next : [zeros[d + 1]];
    idx >>= 1;
  }
  let cur = leaves[leafIndex];
  for (let d = 0; d < 32; d++) cur = pi[d] ? hashN([pe[d], cur]) : hashN([cur, pe[d]]);
  return { root: cur, pe, pi };
}

function packProof(proof) {
  const be = (v) => bigToBe32Fq(BigInt(v));
  const g2 = (p) => Buffer.concat([be(p[1]), be(p[0])]); // groth16-solana: c1 || c0
  return Buffer.concat([
    be(proof.pi_a[0]),
    be(proof.pi_a[1]),
    g2(proof.pi_b[0]),
    g2(proof.pi_b[1]),
    be(proof.pi_c[0]),
    be(proof.pi_c[1]),
  ]);
}

async function sendTx(connection, payer, ixs) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await sleep(400);
      return await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer], {
        commitment: "confirmed",
      });
    } catch (e) {
      if (!/429|Too many requests/i.test(String(e?.message || e)) || attempt === 5) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function asp(method, route, body) {
  const res = await fetch(`${ASP}${route}`, {
    method,
    headers: { Authorization: `Bearer ${ASP_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitFor(what, fn, { timeoutMs = 180_000, everyMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function main() {
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf8"))),
  );
  const connection = new Connection(RPC, "confirmed");
  const [vault] = pda([Buffer.from("siphon-vault-v1")]);
  const [tree] = pda([Buffer.from("siphon-tree-v1")]);
  const [compliance] = pda([Buffer.from("siphon-compliance-v1")]);
  const [vk] = pda([Buffer.from("siphon-vk-v1"), Buffer.from([0])]);
  const recipient = payer.publicKey;
  const t0 = Date.now();
  const lap = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  // The on-chain withdraw1 VK must be the ceremony key this proof is made with.
  const vkInfo = await connection.getAccountInfo(vk, "confirmed");
  const ceremonyBin = path.join(here, "../target/deploy/vk-ceremony/withdraw1.vk.bin");
  if (!vkInfo || !vkInfo.data.subarray(0, 2120).equals(fs.readFileSync(ceremonyBin).subarray(0, 2120))) {
    throw new Error("on-chain withdraw1 VK is not the ceremony key — run upload-vk-devnet.mjs with VK_DIR=vk-ceremony");
  }
  lap("on-chain withdraw1 VK = ceremony");

  const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
  const depositNonce = vaultInfo.data.readBigUInt64LE(73);
  const scope = le32ToField(vaultInfo.data.subarray(146, 178));
  if (hashN([DOMAIN_CHAIN_SOL, fieldFromBe32(PROGRAM_ID.toBytes()), fieldFromBe32(vault.toBytes())]) !== scope) {
    throw new Error("vault_scope_id mismatch");
  }

  // ── note + ASP screen (before funds move) ───────────────────────────────
  const nullifier = randomLimb();
  const secret = randomLimb();
  const userSalt = randomLimb();
  const pre = hashN([nullifier, secret]);
  const label = hashN([hashN([DOMAIN_VAULT_SCOPE, scope, depositNonce]), userSalt]);
  const assetId = fieldFromBe32(NATIVE_MINT.toBytes());
  const commitment = hashN([hashN([AMOUNT, label, assetId]), pre]);

  const screen = await asp("POST", "/screen", {
    chainId: CHAIN_ID,
    depositor: payer.publicKey.toBase58(),
    commitment: commitment.toString(),
    userSalt: userSalt.toString(),
  });
  if (screen.status !== 200 || screen.data.decision !== "admit") {
    throw new Error(`screen not admitted: ${screen.status} ${JSON.stringify(screen.data)}`);
  }
  lap(`screen admit (decision ${screen.data.decisionId || screen.data.decision_id || "ok"})`);

  // ── deposit ──────────────────────────────────────────────────────────────
  const commitmentLe = fieldToLe32(commitment);
  const [leaf] = pda([Buffer.from("siphon-leaf-v1"), commitmentLe]);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  const vaultWsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
  const amountLe = Buffer.alloc(8);
  amountLe.writeBigUInt64LE(AMOUNT);
  const depositSig = await sendTx(connection, payer, [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, userWsol, payer.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: userWsol, lamports: Number(AMOUNT) }),
    createSyncNativeInstruction(userWsol),
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: tree, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: userWsol, isSigner: false, isWritable: true },
        { pubkey: vaultWsol, isSigner: false, isWritable: true },
        { pubkey: leaf, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("deposit"), amountLe, fieldToLe32(userSalt), fieldToLe32(pre), commitmentLe]),
    }),
  ]);
  const leafIndex = Number((await connection.getAccountInfo(leaf, "confirmed")).data.readBigUInt64LE(9));
  lap(`deposit ${depositSig} leaf ${leafIndex}`);

  // ── watcher admits, postman publishes ───────────────────────────────────
  const aspPath = await waitFor("watcher admit", async () => {
    const r = await asp("GET", `/set/path?label=${label}`);
    return r.status === 200 && r.data.pathElements ? r.data : null;
  });
  lap(`ASP admitted label at ASP leaf ${aspPath.leafIndex}`);
  const smt = (await asp("GET", `/set/smt-path?label=${label}`)).data;
  if (!smt.pathElements) throw new Error(`smt-path: ${JSON.stringify(smt)}`);

  await waitFor("postman publish", async () => {
    const info = await connection.getAccountInfo(compliance, "confirmed");
    const onAdmitted = le32ToField(info.data.subarray(9, 41));
    const onRevoked = le32ToField(info.data.subarray(41, 73));
    return onAdmitted === BigInt(aspPath.admittedRoot) && onRevoked === BigInt(smt.revokedRoot);
  });
  lap("postman published roots matching the ASP path");

  // ── state leaves from the indexer ───────────────────────────────────────
  const leavesResp = await waitFor("indexer leaves", async () => {
    const r = await asp("GET", `/solana/state/leaves?chainId=${CHAIN_ID}`);
    return r.status === 200 && r.data.leafCount > leafIndex ? r.data : null;
  });
  const leaves = leavesResp.leaves.map((x) => BigInt(x));
  if (leaves[leafIndex] !== commitment) throw new Error("indexer leaf != our commitment");
  const state = await buildStatePath(leaves, leafIndex);
  lap(`indexer served ${leaves.length} leaves; root matches chain`);

  // ── witness + ceremony proof ─────────────────────────────────────────────
  const outN = randomLimb();
  const outS = randomLimb();
  const salt = randomLimb();
  let pf = 0n;
  for (const b of recipient.toBytes().subarray(0, 20)) pf = (pf << 8n) | BigInt(b);
  const payeeId = hashN([DOMAIN_PAYEE, pf]);
  const lc = hashN([DOMAIN_LABEL_COMMIT, 1n, label, 0n, 0n, 0n, 0n, 0n, salt]);
  const publicInputs = [
    "0", "1", state.root.toString(), String(aspPath.admittedRoot), String(smt.revokedRoot), AMOUNT.toString(),
    "0", "0", "0", hashN([nullifier]).toString(), "0", "0", "0", "0", "0", payeeId.toString(),
    String(PROGRAM_VERSION), assetId.toString(), "0", "0", "0", "0", "0", "0", lc.toString(),
  ];
  const input = {
    publicInputs,
    boundaryIndex: "0",
    inValue: [AMOUNT.toString()],
    inNullifier: [nullifier.toString()],
    inSecret: [secret.toString()],
    inLabel: [label.toString()],
    inAssetId: [assetId.toString()],
    statePathElements: [state.pe.map(String)],
    statePathIndices: [state.pi],
    admittedLeafIndex: [String(aspPath.leafIndex)],
    admittedPathElements: [aspPath.pathElements.map(String)],
    admittedPathIndices: [aspPath.pathIndices.map(Number)],
    revokedSmtPathElements: [smt.pathElements.map(String)],
    revokedSmtPathIndices: [smt.pathIndices.map(Number)],
    revokedSmtLeaf: [String(smt.claimedLeaf ?? "0")],
    outNullifier: outN.toString(),
    outSecret: outS.toString(),
    rawPayee: Array.from(recipient.toBytes().subarray(0, 20)),
    labelCommitSalt: salt.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  if (!(await snarkjs.groth16.verify(VKEY, publicSignals, proof))) throw new Error("local verify failed");
  for (let i = 0; i < 25; i++) {
    if (BigInt(publicSignals[i]) !== BigInt(publicInputs[i])) throw new Error(`publics[${i}] drift`);
  }
  lap("ceremony withdraw1 proof ok (local verify)");

  // ── commit + spend ──────────────────────────────────────────────────────
  const binder = randomBytes(32);
  const [pending] = pda([Buffer.from("siphon-pending-inputs-v1"), binder]);
  const commitSig = await sendTx(connection, payer, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: pending, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("commit_public_inputs"), binder, ...publicSignals.map((p) => fieldToLe32(BigInt(p)))]),
    }),
  ]);
  const [nfPda] = pda([Buffer.from("siphon-nf-v1"), fieldToLe32(BigInt(publicSignals[9]))]);
  const payeeToken = getAssociatedTokenAddressSync(NATIVE_MINT, recipient);
  const before = await connection.getTokenAccountBalance(payeeToken).catch(() => null);
  const spendSig = await sendTx(connection, payer, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payeeToken, recipient, NATIVE_MINT),
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: tree, isSigner: false, isWritable: true },
        { pubkey: compliance, isSigner: false, isWritable: false },
        { pubkey: pending, isSigner: false, isWritable: true },
        { pubkey: vk, isSigner: false, isWritable: false },
        { pubkey: vaultWsol, isSigner: false, isWritable: true },
        { pubkey: payeeToken, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: nfPda, isSigner: false, isWritable: true },
        ...Array.from({ length: 5 }, () => ({ pubkey: payer.publicKey, isSigner: false, isWritable: true })),
      ],
      data: Buffer.concat([disc("spend"), binder, packProof(proof), Buffer.from(recipient.toBytes()), Buffer.from([0])]),
    }),
  ]);
  const after = await connection.getTokenAccountBalance(payeeToken);
  const delta = BigInt(after.value.amount) - BigInt(before?.value?.amount ?? "0");
  if (delta !== AMOUNT) throw new Error(`payee received ${delta}, expected ${AMOUNT}`);
  lap(`spend ${spendSig} — payee +${delta} lamports WSOL`);

  const out = {
    programId: PROGRAM_ID.toBase58(),
    asp: ASP,
    zkSet: "ceremony v5-compliance-split-18977ad380ed48f1",
    depositSig,
    commitSig,
    spendSig,
    leafIndex,
    aspLeafIndex: aspPath.leafIndex,
    admittedRoot: String(aspPath.admittedRoot),
    amountLamports: AMOUNT.toString(),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  const outPath = path.join(here, "../target/deploy/devnet-zk-asp-e2e.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

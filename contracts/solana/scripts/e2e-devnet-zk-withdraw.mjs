/**
 * Devnet E2E — ZK vault deposit (WSOL) → withdraw1 prove → commit → spend.
 *
 * Requires:
 *   - program F8Uq… initialized
 *   - withdraw1 VK matching artifacts-from-v5 / public/zk (dev-beacon)
 *   - siphon-app node_modules (snarkjs, circomlibjs, web3, spl-token)
 *
 *   cd siphon-app
 *   $env:NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID="F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH"
 *   node ../siphon-contracts-v2/solana/scripts/e2e-devnet-zk-withdraw.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../../siphon-app");
const zkRoot = path.resolve(here, "../../../siphon-zk-v2");
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
  LAMPORTS_PER_SOL,
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
const AMOUNT = BigInt(process.env.AMOUNT_LAMPORTS || "5000000");
const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** BN254 base field (Fq) — curve point limbs must reduce mod Fq, not Fr. */
const FQ =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const DOMAIN_VAULT_SCOPE = 3n;
const DOMAIN_CHAIN_SOL = 6n;
const DOMAIN_PAYEE = 4n;
const DOMAIN_LABEL_COMMIT = 7n;
const PROGRAM_VERSION = 5;
const EMPTY_SMT = JSON.parse(
  fs.readFileSync(path.join(zkRoot, "test-vectors/smt/empty-subtrees.json"), "utf8"),
);
const WASM = path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/main_withdraw1.wasm");
const ZKEY = path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/zkey_final.zkey");
const VKEY = JSON.parse(
  fs.readFileSync(path.join(zkRoot, "artifacts-from-v5/zk/withdraw1/verification_key.json"), "utf8"),
);
const VK_BIN = path.join(here, "../target/deploy/vk-devbeacon/withdraw1.vk.bin");

function loadKeypair() {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function eventDisc(name) {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}
function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}
function modField(x) {
  const r = x % FIELD;
  return r < 0n ? r + FIELD : r;
}
function fieldFromBe32(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return modField(v);
}
function fieldToLe32(x) {
  const b = Buffer.alloc(32);
  let v = modField(x);
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
function bigToBe32(n) {
  let x = modField(n);
  const h = x.toString(16).padStart(64, "0");
  return Buffer.from(h, "hex");
}
function bigToBe32Fq(n) {
  let x = BigInt(n) % FQ;
  if (x < 0n) x += FQ;
  return Buffer.from(x.toString(16).padStart(64, "0"), "hex");
}
function randomLimb() {
  const b = Buffer.concat([randomBytes(31), Buffer.from([0])]);
  let v = 0n;
  for (let i = 0; i < 32; i++) v |= BigInt(b[i]) << BigInt(8 * i);
  return v === 0n ? 1n : modField(v);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const poseidon = await buildPoseidon();
const hashN = (xs) => BigInt(poseidon.F.toObject(poseidon(xs.map(modField))));

async function oneLeafPath(leaf) {
  const pe = [];
  const pi = [];
  let zero = 0n;
  let root = BigInt(leaf);
  for (let l = 0; l < 32; l++) {
    pe.push(zero);
    pi.push(0);
    root = await hashN([root, zero]);
    zero = await hashN([zero, zero]);
  }
  return { root, pe, pi };
}

async function buildStatePath(leaves, leafIndex) {
  const zeros = [0n];
  for (let i = 1; i <= 32; i++) zeros[i] = await hashN([zeros[i - 1], zeros[i - 1]]);
  const pe = [];
  const pi = [];
  let level = leaves.slice();
  let idx = leafIndex;
  for (let d = 0; d < 32; d++) {
    const isRight = idx & 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    pe.push(sibIdx < level.length ? level[sibIdx] : zeros[d]);
    pi.push(isRight);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const L = level[i];
      const R = i + 1 < level.length ? level[i + 1] : zeros[d];
      next.push(await hashN([L, R]));
    }
    level = next.length ? next : [zeros[d + 1]];
    idx >>= 1;
  }
  let cur = leaves[leafIndex];
  for (let d = 0; d < 32; d++) {
    cur = pi[d] ? await hashN([pe[d], cur]) : await hashN([cur, pe[d]]);
  }
  return { root: cur, pe, pi };
}

function emptySmt(key) {
  const pe = [];
  for (let i = 0; i < 32; i++) pe.push(EMPTY_SMT.EMPTY_SUBTREE[String(i)]);
  const bits = [];
  const k = BigInt(key);
  for (let j = 0; j < 32; j++) bits.push(Number((k >> (253n - BigInt(j))) & 1n));
  return { pe, bits, root: EMPTY_SMT.EMPTY_REVOKED_ROOT };
}

async function labelCommit(n, labels, salt) {
  const padded = Array.from({ length: 6 }, (_, i) => labels[i] ?? 0n);
  return hashN([DOMAIN_LABEL_COMMIT, BigInt(n), ...padded, salt]);
}

/** EVM PayeeId over first 20 bytes of Solana pubkey (matches on-chain spend_payee_id_compat). */
async function spendPayeeIdCompat(pubkeyBytes) {
  let pf = 0n;
  for (let i = 0; i < 20; i++) pf = (pf << 8n) | BigInt(pubkeyBytes[i]);
  return hashN([DOMAIN_PAYEE, pf]);
}

function packProof(proof, c1First = true) {
  const be = (v) => bigToBe32Fq(BigInt(v));
  // groth16-solana / Light: Fp2 limbs as c1 || c0 (must match export-vk-accounts).
  const g2 = (p) =>
    c1First ? Buffer.concat([be(p[1]), be(p[0])]) : Buffer.concat([be(p[0]), be(p[1])]);
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
      return await sendAndConfirmTransaction(
        connection,
        new Transaction().add(...(Array.isArray(ixs) ? ixs : [ixs])),
        [payer],
        { commitment: "confirmed" },
      );
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/429|Too many requests/i.test(msg) || attempt === 5) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function overwriteWithdraw1Vk(connection, payer, vault) {
  if (!fs.existsSync(VK_BIN)) throw new Error(`missing ${VK_BIN} — run export-vk-accounts --src public/zk`);
  const blob = fs.readFileSync(VK_BIN);
  const [vk] = pda([Buffer.from("siphon-vk-v1"), Buffer.from([0])]);
  const existing = await connection.getAccountInfo(vk);
  if (existing && existing.data.subarray(0, 2120).equals(blob.subarray(0, 2120))) {
    console.log("withdraw1 VK already matches dev-beacon");
    return vk;
  }
  // The vault now carries the MPC ceremony VKs (what the app proves with). Overwriting slot 0 with
  // the dev-beacon key would make every app/ceremony withdraw fail verification — opt in explicitly.
  if (process.env.ALLOW_DEVBEACON_VK !== "1") {
    throw new Error(
      "on-chain withdraw1 VK is not dev-beacon (ceremony set is live). Use e2e-devnet-zk-asp.mjs, " +
        "or set ALLOW_DEVBEACON_VK=1 to overwrite it deliberately.",
    );
  }
  const CHUNK = 900;
  for (let off = 0; off < 2120; off += CHUNK) {
    const chunk = blob.subarray(off, Math.min(off + CHUNK, 2120));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(chunk.length, 0);
    const offB = Buffer.alloc(2);
    offB.writeUInt16LE(off, 0);
    const data = Buffer.concat([disc("write_vk_chunk"), offB, len, chunk]);
    await sendTx(
      connection,
      payer,
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: vault, isSigner: false, isWritable: false },
          { pubkey: vk, isSigner: false, isWritable: true },
        ],
        data,
      }),
    );
  }
  console.log("overwrote withdraw1 VK →", vk.toBase58());
  return vk;
}

async function setCompliance(connection, payer, vault, admittedRoot, revokedRoot) {
  const [compliance] = pda([Buffer.from("siphon-compliance-v1")]);
  const data = Buffer.concat([
    disc("set_compliance"),
    fieldToLe32(admittedRoot),
    fieldToLe32(BigInt(revokedRoot)),
  ]);
  const sig = await sendTx(
    connection,
    payer,
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: compliance, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
  );
  console.log("set_compliance", compliance.toBase58(), sig);
  return compliance;
}

const LEAF_CACHE = path.join(here, "../target/deploy/devnet-zk-leaves.json");

function loadLeafCache() {
  if (!fs.existsSync(LEAF_CACHE)) return new Map();
  const obj = JSON.parse(fs.readFileSync(LEAF_CACHE, "utf8"));
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) m.set(Number(k), BigInt(v));
  return m;
}

function saveLeafCache(found) {
  const obj = {};
  for (const [k, v] of found.entries()) obj[String(k)] = v.toString();
  fs.mkdirSync(path.dirname(LEAF_CACHE), { recursive: true });
  fs.writeFileSync(LEAF_CACHE, JSON.stringify(obj));
}

async function scanDepositLeaves(connection, vault, nextIndex, known = {}) {
  const discBytes = eventDisc("DepositEvent");
  const found = loadLeafCache();
  for (const [idx, commitment] of Object.entries(known)) {
    found.set(Number(idx), BigInt(commitment));
  }
  const missing = [];
  for (let i = 0; i < nextIndex; i++) if (!found.has(i)) missing.push(i);
  if (missing.length === 0) {
    saveLeafCache(found);
    return Array.from({ length: nextIndex }, (_, i) => found.get(i));
  }
  console.log(`scanning DepositEvents for ${missing.length} missing leaf(s)…`);
  let before;
  for (;;) {
    await sleep(900);
    let page;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        page = await connection.getSignaturesForAddress(vault, { before, limit: 25 }, "confirmed");
        break;
      } catch (e) {
        if (!/429|Too many/i.test(String(e?.message || e)) || attempt === 9) throw e;
        await sleep(Math.min(60_000, 1500 * 2 ** attempt));
      }
    }
    for (const s of page) {
      if (s.err) continue;
      await sleep(700);
      let t;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          t = await connection.getTransaction(s.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          break;
        } catch (e) {
          if (!/429|Too many/i.test(String(e?.message || e)) || attempt === 9) throw e;
          await sleep(Math.min(60_000, 1500 * 2 ** attempt));
        }
      }
      for (const line of t?.meta?.logMessages ?? []) {
        if (!line.startsWith("Program data: ")) continue;
        const raw = Buffer.from(line.slice("Program data: ".length), "base64");
        if (raw.length < 8 + 112) continue;
        if (!raw.subarray(0, 8).equals(discBytes)) continue;
        const commitment = raw.subarray(8 + 64, 8 + 96);
        const idx = Number(raw.readBigUInt64LE(8 + 96));
        found.set(idx, le32ToField(commitment));
      }
      if (missing.every((i) => found.has(i))) break;
    }
    if (missing.every((i) => found.has(i)) || page.length < 25) break;
    before = page[page.length - 1].signature;
  }
  saveLeafCache(found);
  const leaves = [];
  for (let i = 0; i < nextIndex; i++) {
    if (!found.has(i)) throw new Error(`missing DepositEvent for leaf ${i}`);
    leaves.push(found.get(i));
  }
  return leaves;
}

async function main() {
  if (!fs.existsSync(WASM) || !fs.existsSync(ZKEY)) {
    throw new Error("missing withdraw1 wasm/zkey under siphon-zk-v2/artifacts-from-v5");
  }
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const [vault] = pda([Buffer.from("siphon-vault-v1")]);
  const [tree] = pda([Buffer.from("siphon-tree-v1")]);
  const recipient = process.env.ZK_SPEND_RECIPIENT
    ? new PublicKey(process.env.ZK_SPEND_RECIPIENT)
    : payer.publicKey;

  console.log("program", PROGRAM_ID.toBase58());
  console.log("vault", vault.toBase58());
  console.log("payer", payer.publicKey.toBase58());

  const vkAccount = await overwriteWithdraw1Vk(connection, payer, vault);

  const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
  if (!vaultInfo) throw new Error("vault missing");
  const depositNonce = vaultInfo.data.readBigUInt64LE(73);
  const vaultScopeLe = vaultInfo.data.subarray(146, 178);
  const scopeOnchain = le32ToField(vaultScopeLe);
  const scopeLocal = await hashN([
    DOMAIN_CHAIN_SOL,
    fieldFromBe32(PROGRAM_ID.toBytes()),
    fieldFromBe32(vault.toBytes()),
  ]);
  if (scopeLocal !== scopeOnchain) throw new Error("vault_scope_id mismatch");

  // ── deposit ──────────────────────────────────────────────────────────────
  const nullifier = randomLimb();
  const secret = randomLimb();
  const userSalt = randomLimb();
  const pre = await hashN([nullifier, secret]);
  const stem = await hashN([DOMAIN_VAULT_SCOPE, scopeOnchain, depositNonce]);
  const label = await hashN([stem, userSalt]);
  const assetId = fieldFromBe32(NATIVE_MINT.toBytes());
  const inner = await hashN([AMOUNT, label, assetId]);
  const commitment = await hashN([inner, pre]);
  const commitmentLe = fieldToLe32(commitment);
  const [leaf] = pda([Buffer.from("siphon-leaf-v1"), commitmentLe]);
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  const vaultWsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);

  const amountLe = Buffer.alloc(8);
  amountLe.writeBigUInt64LE(AMOUNT);
  const depositIx = new TransactionInstruction({
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
    data: Buffer.concat([
      disc("deposit"),
      amountLe,
      fieldToLe32(userSalt),
      fieldToLe32(pre),
      commitmentLe,
    ]),
  });

  const depositSig = await sendTx(connection, payer, [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      userWsol,
      payer.publicKey,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userWsol,
      lamports: Number(AMOUNT),
    }),
    createSyncNativeInstruction(userWsol),
    depositIx,
  ]);
  const leafInfo = await connection.getAccountInfo(leaf, "confirmed");
  const leafIndex = Number(leafInfo.data.readBigUInt64LE(9));
  console.log("deposit", depositSig, "leaf", leafIndex);

  // ── compliance = ASP tree of [label] + empty revoked SMT ─────────────────
  const asp = await oneLeafPath(label);
  const smtKey = await hashN([1n, label]);
  const smt = emptySmt(smtKey);
  await setCompliance(connection, payer, vault, asp.root, smt.root);

  // ── state leaves ─────────────────────────────────────────────────────────
  const treeInfo = await connection.getAccountInfo(tree, "confirmed");
  const nextIndex = Number(treeInfo.data.readBigUInt64LE(16));
  const leaves = await scanDepositLeaves(connection, vault, nextIndex, {
    [leafIndex]: commitment,
  });
  const state = await buildStatePath(leaves, leafIndex);
  const onchainRoot = le32ToField(treeInfo.data.subarray(24, 56));
  if (state.root !== onchainRoot) {
    throw new Error(`state root mismatch client=${state.root} chain=${onchainRoot}`);
  }

  // ── witness + prove ──────────────────────────────────────────────────────
  const outN = randomLimb();
  const outS = randomLimb();
  const salt = randomLimb();
  const nh = await hashN([nullifier]);
  const payeeId = await spendPayeeIdCompat(recipient.toBytes());
  const lc = await labelCommit(1, [label], salt);
  const rawPayee20 = Array.from(recipient.toBytes().subarray(0, 20));

  const publicInputs = [
    "0",
    "1",
    state.root.toString(),
    asp.root.toString(),
    smt.root,
    AMOUNT.toString(),
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
    String(PROGRAM_VERSION),
    assetId.toString(),
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
    inValue: [AMOUNT.toString()],
    inNullifier: [nullifier.toString()],
    inSecret: [secret.toString()],
    inLabel: [label.toString()],
    inAssetId: [assetId.toString()],
    statePathElements: [state.pe.map(String)],
    statePathIndices: [state.pi],
    admittedLeafIndex: ["0"],
    admittedPathElements: [asp.pe.map(String)],
    admittedPathIndices: [asp.pi],
    revokedSmtPathElements: [smt.pe],
    revokedSmtPathIndices: [smt.bits],
    revokedSmtLeaf: ["0"],
    outNullifier: outN.toString(),
    outSecret: outS.toString(),
    rawPayee: rawPayee20,
    labelCommitSalt: salt.toString(),
  };

  console.log("proving withdraw1…");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  if (!(await snarkjs.groth16.verify(VKEY, publicSignals, proof))) {
    throw new Error("local verify failed");
  }
  for (let i = 0; i < 25; i++) {
    if (BigInt(publicSignals[i]) !== BigInt(publicInputs[i])) {
      throw new Error(`publics[${i}] drift`);
    }
  }
  const packed = packProof(proof, true);
  console.log("proof ok", packed.length, "bytes");
  console.log("proof_b0", [...packed.subarray(64, 72)]);
  {
    const fixDir = path.join(here, "../target/deploy/host-verify-fixtures");
    fs.mkdirSync(fixDir, { recursive: true });
    fs.writeFileSync(path.join(fixDir, "e2e.proof.c1.bin"), packed);
    fs.writeFileSync(path.join(fixDir, "e2e.proof.c0.bin"), packProof(proof, false));
    fs.writeFileSync(
      path.join(fixDir, "e2e.publics.le.bin"),
      Buffer.concat(publicSignals.map((p) => fieldToLe32(BigInt(p)))),
    );
    fs.writeFileSync(path.join(fixDir, "e2e.proof.json"), JSON.stringify({ proof, publicSignals }));
    fs.copyFileSync(VK_BIN, path.join(fixDir, "e2e.vk.c1.bin"));
  }

  const binder = randomBytes(32);
  if (process.env.ZK_SPEND_PACKAGE_OUT) {
    const nfLimb = fieldToLe32(BigInt(publicSignals[9]));
    const pkg = {
      venue: "meteora-dlmm",
      program_id: PROGRAM_ID.toBase58(),
      circuit: "withdraw1",
      circuit_index: 0,
      binder_hex: Buffer.from(binder).toString("hex"),
      proof_hex: Buffer.from(packed).toString("hex"),
      publics: publicSignals.map(String),
      nullifiers_hex: [Buffer.from(nfLimb).toString("hex")],
      mint: NATIVE_MINT.toBase58(),
      settlement: recipient.toBase58(),
      state_root: publicSignals[2],
      amount_base_units: AMOUNT.toString(),
      solana_side: "sell_wsol",
      depositSig,
      leafIndex,
    };
    fs.writeFileSync(process.env.ZK_SPEND_PACKAGE_OUT, JSON.stringify(pkg, null, 2));
    console.log("wrote spend package", process.env.ZK_SPEND_PACKAGE_OUT);
    console.log("deposit", depositSig, "— spend left to the executor");
    process.exit(0);
  }

  // ── commit ───────────────────────────────────────────────────────────────
  const [pending] = pda([Buffer.from("siphon-pending-inputs-v1"), binder]);
  const commitData = Buffer.concat([
    disc("commit_public_inputs"),
    binder,
    ...publicSignals.map((p) => fieldToLe32(BigInt(p))),
  ]);
  const commitSig = await sendTx(
    connection,
    payer,
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: pending, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: commitData,
    }),
  );
  console.log("commit", commitSig);

  // ── spend ────────────────────────────────────────────────────────────────
  const [compliance] = pda([Buffer.from("siphon-compliance-v1")]);
  const nfLimb = fieldToLe32(BigInt(publicSignals[9]));
  const [nfPda] = pda([Buffer.from("siphon-nf-v1"), nfLimb]);
  const payeeToken = getAssociatedTokenAddressSync(NATIVE_MINT, recipient);
  const spendData = Buffer.concat([
    disc("spend"),
    binder,
    packed,
    Buffer.from(recipient.toBytes()),
    Buffer.from([0]), // withdraw1 circuit index
  ]);
  const spendIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: compliance, isSigner: false, isWritable: false },
      { pubkey: pending, isSigner: false, isWritable: true },
      { pubkey: vkAccount, isSigner: false, isWritable: false },
      { pubkey: vaultWsol, isSigner: false, isWritable: true },
      { pubkey: payeeToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Unused nullifier slots must still be mut; program id is not writable (ConstraintMut).
      { pubkey: nfPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
    ],
    data: spendData,
  });

  const balBefore = await connection.getTokenAccountBalance(payeeToken).catch(() => null);
  const spendSig = await sendTx(connection, payer, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      payeeToken,
      recipient,
      NATIVE_MINT,
    ),
    spendIx,
  ]);
  const balAfter = await connection.getTokenAccountBalance(payeeToken);
  console.log("spend", spendSig);
  console.log("payee WSOL", balBefore?.value?.amount, "→", balAfter.value.amount);

  const out = {
    programId: PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    depositSig,
    commitSig,
    spendSig,
    leafIndex,
    amountLamports: AMOUNT.toString(),
    payeeBalance: balAfter.value.amount,
  };
  const outPath = path.join(here, "../target/deploy/devnet-zk-withdraw-e2e.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

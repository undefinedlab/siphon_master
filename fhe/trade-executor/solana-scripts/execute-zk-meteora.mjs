/**
 * Settle a fired Devnet order: submit the client-built Groth16 spend to the settlement wallet,
 * swap exactly that payout on Meteora DLMM, then RETURN the output into the vault as a note the
 * user owns (a deposit under the user's precommitment) — or, without `return`, pay `recipient`.
 *
 * stdin: one JSON package —
 *   publics[25], proof_hex, binder_hex, nullifiers_hex[], circuit_index, mint, settlement,
 *   meteora_pool, slippage_bps?, return?: { precommitment, user_salt } (decimal field strings),
 *   recipient? (required without `return`), resume? (a STAGED line from an earlier run).
 *
 * stdout: JSON lines. A `{stage: …}` line after each step that moved funds, then a final line:
 *   exit 0  { ok: true, status: "EXECUTED", … returned note's public data }
 *   exit 3  NEEDS_REPROOF — nothing sent (the proof cites a root the vault no longer accepts)
 *   exit 4  NO_ROUTE      — nothing sent (the pool cannot fill the whole input right now)
 *   exit 5  STAGED        — the spend landed but a later step failed; pass the line back as
 *                           `resume` to finish. Funds sit in the settlement wallet meanwhile.
 *   exit 1  FAILED        — nothing that moved funds was sent
 * The caller holds one lock per settlement wallet: every amount here is a balance DELTA.
 *
 * The relayer keypair signs. Note secrets are not accepted — only the precommitment.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const dlmmMod = require("@meteora-ag/dlmm");
const DLMM = dlmmMod.default || dlmmMod;
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const BN = require("bn.js");
const { poseidon2, poseidon3 } = require("poseidon-lite");

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
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAccount,
} = spl;

const SPEND_CU = 1_400_000;
const DEPOSIT_CU = 600_000;
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DOMAIN_VAULT_SCOPE = 3n;
const ERR_INVALID_COMMITMENT = 6022; // VaultError::InvalidCommitment — another deposit took the nonce

// ── encoding ────────────────────────────────────────────────────────────────────────────────

function loadKeypair() {
  const raw = (process.env.SOLANA_RELAYER_KEYPAIR || "").trim();
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  if (raw && !raw.includes(path.sep) && raw.length > 80) {
    try {
      return Keypair.fromSecretKey(Buffer.from(raw, "base64"));
    } catch {
      /* fall through to file */
    }
  }
  const p = raw && fs.existsSync(raw) ? raw : path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

function leToField(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function fieldToLe32(x) {
  const b = Buffer.alloc(32);
  let v = BigInt(x);
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

const u64Le = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

/** The note asset: the mint as a big-endian integer, reduced mod p (what deposit hashes). */
const mintField = (mint) => BigInt("0x" + Buffer.from(mint.toBytes()).toString("hex")) % FIELD_P;

// ── output ──────────────────────────────────────────────────────────────────────────────────

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const EXIT = { NEEDS_REPROOF: 3, NO_ROUTE: 4, STAGED: 5 };
function fail(code, message, extra = {}) {
  emit({ ok: false, code, error: message, ...extra });
  process.exit(EXIT[code] ?? 1);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("empty stdin");
  return JSON.parse(text);
}

async function send(connection, payer, ixs) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
}

async function tokenBalance(connection, ata) {
  try {
    return (await getAccount(connection, ata, "confirmed")).amount;
  } catch {
    return 0n;
  }
}

/** Anchor custom error code from a failed send, if any. */
function anchorCode(err) {
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(String(err?.message || err));
  return m ? parseInt(m[1], 16) : null;
}

// ── on-chain state ──────────────────────────────────────────────────────────────────────────

// TreeAccount (zero-copy): disc 8 | bump u8 | recent_len u8 | recent_head u8 | pad 5 | next_index
// u64 | root [32] | filled_subtrees [32;32] | zero_hashes [32;32] | recent_roots [32;CAP].
const TREE_RING_OFF = 8 + 8 + 8 + 32 + 32 * 32 * 2;
function stateRootKnown(treeData, rootLe) {
  const len = treeData[9];
  for (let i = 0; i < len; i++) {
    const off = TREE_RING_OFF + i * 32;
    if (off + 32 <= treeData.length && treeData.subarray(off, off + 32).equals(rootLe)) return true;
  }
  return false;
}

// ComplianceAccount (borsh): disc 8 | bump u8 | admitted [32] | revoked [32] | ring_head u8 |
// ring_len u8 | admitted_ring [32;N]. The program accepts any ring entry, but only the CURRENT
// revoked root. An account without the ring (older program) accepts only the current pair.
function complianceAccepts(data, admittedLe, revokedLe) {
  if (!data.subarray(41, 73).equals(revokedLe)) return false;
  if (data.subarray(9, 41).equals(admittedLe)) return true;
  if (data.length < 75) return false;
  const len = data[74];
  for (let i = 0; i < len; i++) {
    const off = 75 + i * 32;
    if (data.subarray(off, off + 32).equals(admittedLe)) return true;
  }
  return false;
}

// VaultAccount (borsh): disc 8 | bump u8 | authority [32] | program_version [32] | deposit_nonce
// u64 | state_root [32] | deposits_paused u8 | allowed_mint [32] | vault_scope_id [32] | vk [32;14].
const vaultNonce = (data) => data.readBigUInt64LE(73);
const vaultScope = (data) => leToField(data.subarray(146, 178));
const vaultVk = (data, i) => new PublicKey(data.subarray(178 + i * 32, 178 + i * 32 + 32));

// ── main ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const pkg = await readStdin();
  const publics = pkg.publics;
  if (!Array.isArray(publics) || publics.length !== 25) fail("BAD_PACKAGE", "publics must be 25 limbs");
  if (!pkg.proof_hex || pkg.proof_hex.length !== 512) fail("BAD_PACKAGE", "proof_hex must be 256 bytes");
  if (!pkg.binder_hex || pkg.binder_hex.length !== 64) fail("BAD_PACKAGE", "binder_hex must be 32 bytes");
  for (const k of ["meteora_pool", "settlement", "mint"]) if (!pkg[k]) fail("BAD_PACKAGE", `${k} required`);
  const ret = pkg.return || null;
  if (ret && (!ret.precommitment || !ret.user_salt || BigInt(ret.user_salt) === 0n)) {
    fail("BAD_PACKAGE", "return needs a precommitment and a non-zero user_salt");
  }
  if (!ret && !pkg.recipient) fail("BAD_PACKAGE", "recipient or return required");
  const screenUrl = (process.env.SOLASP_URL || "").replace(/\/$/, "");
  const screenToken = process.env.SOLASP_SCREEN_TOKEN || "";
  // Checked before anything moves: a returned note nobody screened is never admitted, so it
  // could never be spent.
  if (ret && (!screenUrl || !screenToken)) fail("NO_SCREEN", "SOLASP_URL and SOLASP_SCREEN_TOKEN are required to return output to the vault");

  const programId = new PublicKey(
    pkg.program_id || process.env.SIPHON_ZK_PROGRAM_ID || process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID,
  );
  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const payer = loadKeypair();
  const settlement = new PublicKey(pkg.settlement);
  if (!payer.publicKey.equals(settlement)) {
    fail("SETTLEMENT_MISMATCH", `proof settlement ${settlement.toBase58()} != relayer ${payer.publicKey.toBase58()}`);
  }
  const mint = new PublicKey(pkg.mint);
  const poolPk = new PublicKey(pkg.meteora_pool);
  const slippageBps = Math.min(Math.max(Number(pkg.slippage_bps ?? 50) || 50, 1), 1000);
  const amountIn = BigInt(publics[5]);
  const seed = (s, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], programId)[0];
  const vault = seed("siphon-vault-v1");
  const tree = seed("siphon-tree-v1");
  const compliance = seed("siphon-compliance-v1");

  // Leave tokens in token accounts: the SDK otherwise wraps SOL into the input account and closes
  // the output account to lamports, so neither amount is the order's own.
  const pool = await DLMM.create(connection, poolPk, { cluster: "devnet", skipSolWrappingOperation: true });
  const tokenX = pool.tokenX.publicKey;
  const tokenY = pool.tokenY.publicKey;
  if (!mint.equals(tokenX) && !mint.equals(tokenY)) {
    fail("MINT_NOT_IN_POOL", `spend mint ${mint.toBase58()} is not in pool ${poolPk.toBase58()}`);
  }
  const swapForY = mint.equals(tokenX);
  const outMint = swapForY ? tokenY : tokenX;
  const inAta = getAssociatedTokenAddressSync(mint, settlement, true);
  const outAta = getAssociatedTokenAddressSync(outMint, settlement, true);

  const r = pkg.resume || {};
  const st = {
    stage: r.stage || "NEW",
    spend_sig: r.spend_sig,
    swap_sig: r.swap_sig,
    amount_in: amountIn.toString(),
    mint_in: mint.toBase58(),
    amount_out: r.amount_out,
    mint_out: outMint.toBase58(),
    deposit: r.deposit,
  };
  const staged = (err) =>
    fail("STAGED", err instanceof Error ? err.message : String(err), { resume: { ...st } });

  const quote = async (amount) => {
    const bins = await pool.getBinArrayForSwap(swapForY, 4);
    return pool.swapQuote(new BN(amount.toString()), swapForY, new BN(slippageBps), bins, false);
  };

  // ── 1. spend ──────────────────────────────────────────────────────────────────────────────
  if (st.stage === "NEW") {
    const nullifiers = (pkg.nullifiers_hex || []).map((h) => Buffer.from(h, "hex"));
    if (!nullifiers.length) fail("BAD_PACKAGE", "nullifiers_hex required");
    // A spent nullifier with no resume means an earlier run spent and lost its result; swapping
    // "the" balance now could spend another order's funds. Stop for an operator.
    if (await connection.getAccountInfo(seed("siphon-nf-v1", nullifiers[0]), "confirmed")) {
      fail("SPENT_UNTRACKED", "this note was already spent and no resume state was given");
    }

    const [treeInfo, compInfo] = await connection.getMultipleAccountsInfo([tree, compliance], "confirmed");
    if (!treeInfo || !compInfo) fail("NO_VAULT", "ZK vault tree or compliance account missing");
    if (!stateRootKnown(treeInfo.data, fieldToLe32(publics[2]))) {
      fail("NEEDS_REPROOF", "the proof's state root has aged out of the vault's recent roots");
    }
    if (!complianceAccepts(compInfo.data, fieldToLe32(publics[3]), fieldToLe32(publics[4]))) {
      fail("NEEDS_REPROOF", "the proof's compliance roots are no longer accepted (a label was revoked, or the ring moved on)");
    }
    // Quote before anything is sent: a partial fill would strand the rest in the settlement wallet.
    // The SDK throws (rather than quoting a partial fill) when the bins run dry.
    const q = await quote(amountIn).catch((err) =>
      fail("NO_ROUTE", `the Devnet pool cannot fill this amount right now, try a smaller one (${err?.message || err})`));
    if (BigInt(q.consumedInAmount.toString()) < amountIn) {
      fail("NO_ROUTE", `the pool can only fill ${q.consumedInAmount} of ${amountIn} right now`);
    }

    const binder = Buffer.from(pkg.binder_hex, "hex");
    const pending = seed("siphon-pending-inputs-v1", binder);
    // A commit that landed while its spend did not is reused: re-committing the binder would fail.
    if (!(await connection.getAccountInfo(pending, "confirmed"))) {
      await send(connection, payer, [
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: false },
            { pubkey: pending, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([disc("commit_public_inputs"), binder, ...publics.map(fieldToLe32)]),
        }),
      ]);
    }

    const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
    const circuitIndex = Number(pkg.circuit_index ?? 0);
    const nfAccounts = Array.from({ length: 6 }, (_, i) => ({
      pubkey: nullifiers[i] ? seed("siphon-nf-v1", nullifiers[i]) : payer.publicKey,
      isSigner: false,
      isWritable: true,
    }));
    try {
      st.spend_sig = await send(connection, payer, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: SPEND_CU }),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, inAta, settlement, mint),
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: tree, isSigner: false, isWritable: true },
            { pubkey: compliance, isSigner: false, isWritable: false },
            { pubkey: pending, isSigner: false, isWritable: true },
            { pubkey: vaultVk(vaultInfo.data, circuitIndex), isSigner: false, isWritable: false },
            { pubkey: getAssociatedTokenAddressSync(mint, vault, true), isSigner: false, isWritable: true },
            { pubkey: inAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ...nfAccounts,
          ],
          data: Buffer.concat([
            disc("spend"),
            binder,
            Buffer.from(pkg.proof_hex, "hex"),
            settlement.toBuffer(),
            Buffer.from([circuitIndex]),
          ]),
        }),
      ]);
    } catch (err) {
      // UnknownStateRoot / ComplianceRootMismatch: a root moved between the checks and the send.
      const code = anchorCode(err);
      if (code === 6013 || code === 6014) fail("NEEDS_REPROOF", `spend rejected (${code}): roots moved`);
      // A confirmation timeout is not a failed spend: if the nullifier exists, it landed.
      if (!(await connection.getAccountInfo(seed("siphon-nf-v1", nullifiers[0]), "confirmed"))) throw err;
      st.spend_sig = "unconfirmed";
    }
    st.stage = "SPENT";
    emit({ stage: st.stage, resume: { ...st } });
  }

  // ── 2. swap exactly the spend's payout ────────────────────────────────────────────────────
  if (st.stage === "SPENT") {
    try {
      await send(connection, payer, [
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, outAta, settlement, outMint),
      ]);
      const before = await tokenBalance(connection, outAta);
      const q = await quote(amountIn);
      const swapTx = await pool.swap({
        inToken: mint,
        outToken: outMint,
        inAmount: new BN(amountIn.toString()),
        minOutAmount: q.minOutAmount,
        lbPair: pool.pubkey,
        user: payer.publicKey,
        binArraysPubkey: q.binArraysPubkey,
      });
      st.swap_sig = await sendAndConfirmTransaction(connection, swapTx, [payer], { commitment: "confirmed" });
      const got = (await tokenBalance(connection, outAta)) - before;
      if (got <= 0n) throw new Error(`swap ${st.swap_sig} produced no ${outMint.toBase58()}`);
      st.amount_out = got.toString();
    } catch (err) {
      staged(err);
    }
    st.stage = "SWAPPED";
    emit({ stage: st.stage, resume: { ...st } });
  }

  // ── 3. return the output ──────────────────────────────────────────────────────────────────
  // A resumed SWAPPED may cite an amount from a prior (wrong) pool/mint; deposit only what is
  // actually sitting in the output ATA (e.g. after an operator converted Circle USDC → DteUan).
  {
    const have = await tokenBalance(connection, outAta);
    if (!st.amount_out || BigInt(st.amount_out) > have) {
      if (have <= 0n) staged(new Error(`no ${outMint.toBase58()} balance to return`));
      st.amount_out = have.toString();
      st.mint_out = outMint.toBase58();
    }
  }
  const amountOut = BigInt(st.amount_out);
  let note = null;
  try {
    if (ret) {
      note = await returnToVault({
        connection, payer, programId, vault, tree, outMint, outAta, amountOut, ret, st, seed,
        screenUrl, screenToken,
      });
    } else {
      const recipient = new PublicKey(pkg.recipient);
      const dest = getAssociatedTokenAddressSync(outMint, recipient, true);
      st.payout_sig = await send(connection, payer, [
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, recipient, outMint),
        createTransferInstruction(outAta, dest, payer.publicKey, amountOut),
      ]);
    }
  } catch (err) {
    staged(err);
  }

  const changeLimb = BigInt(publics[7]);
  emit({
    ok: true,
    status: "EXECUTED",
    venue: "meteora-dlmm",
    tx_hash: st.spend_sig,
    spend_sig: st.spend_sig,
    swap_sig: st.swap_sig,
    payout_sig: st.payout_sig,
    pool: poolPk.toBase58(),
    mint_in: st.mint_in,
    mint_out: st.mint_out,
    amount_in: st.amount_in,
    amount_out: st.amount_out,
    change_commitment: changeLimb === 0n ? null : changeLimb.toString(),
    returned_note: note,
  });
}

/**
 * Deposit `amountOut` from the settlement wallet under the user's precommitment. Each attempt is
 * screened first (solasp only admits a deposit it screened), and the commitment binds the vault's
 * deposit_nonce, so a deposit that loses the race to another one is recomputed and retried.
 */
async function returnToVault(a) {
  const { connection, payer, programId, vault, tree, outMint, outAta, amountOut, ret, st, seed } = a;
  const leafOf = (commitment) => seed("siphon-leaf-v1", fieldToLe32(commitment));
  const readLeaf = async (commitment) => {
    const info = await connection.getAccountInfo(leafOf(commitment), "confirmed");
    return info ? info.data.readBigUInt64LE(9) : null;
  };
  const noteOf = (d, leafIndex, sig) => ({
    commitment: d.commitment,
    deposit_nonce: d.nonce,
    leaf_index: leafIndex.toString(),
    amount: amountOut.toString(),
    mint: outMint.toBase58(),
    user_salt: String(ret.user_salt),
    deposit_sig: sig ?? d.sig ?? null,
  });

  // A resumed run may already have landed its deposit before it could report it.
  if (st.deposit?.commitment) {
    const leaf = await readLeaf(st.deposit.commitment);
    if (leaf !== null) return noteOf(st.deposit, leaf);
  }

  const salt = BigInt(ret.user_salt);
  const pre = BigInt(ret.precommitment);
  for (let attempt = 0; attempt < 4; attempt++) {
    const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
    const nonce = vaultNonce(vaultInfo.data);
    const label = poseidon2([poseidon3([DOMAIN_VAULT_SCOPE, vaultScope(vaultInfo.data), nonce]), salt]);
    const commitment = poseidon2([poseidon3([amountOut, label, mintField(outMint)]), pre]);
    st.deposit = { commitment: commitment.toString(), nonce: nonce.toString() };

    const res = await fetch(`${a.screenUrl}/screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.screenToken}` },
      body: JSON.stringify({
        chainId: 900002,
        depositor: payer.publicKey.toBase58(),
        commitment: commitment.toString(),
        userSalt: salt.toString(),
      }),
    });
    const screened = await res.json().catch(() => ({}));
    if (!res.ok || screened.decision !== "admit" || !screened.pendingAdmit) {
      throw new Error(`solasp did not admit the returned note (${screened.decision || screened.error || res.status})`);
    }

    emit({ stage: "DEPOSITING", resume: { ...st } });
    try {
      const sig = await send(connection, payer, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: DEPOSIT_CU }),
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: tree, isSigner: false, isWritable: true },
            { pubkey: outMint, isSigner: false, isWritable: false },
            { pubkey: outAta, isSigner: false, isWritable: true },
            { pubkey: getAssociatedTokenAddressSync(outMint, vault, true), isSigner: false, isWritable: true },
            { pubkey: leafOf(commitment), isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([
            disc("deposit"),
            u64Le(amountOut),
            fieldToLe32(salt),
            fieldToLe32(pre),
            fieldToLe32(commitment),
          ]),
        }),
      ]);
      st.deposit.sig = sig;
      return noteOf(st.deposit, await readLeaf(commitment), sig);
    } catch (err) {
      if (anchorCode(err) !== ERR_INVALID_COMMITMENT) throw err;
      // Another deposit took this nonce first; recompute against the new one.
    }
  }
  throw new Error("lost the deposit-nonce race four times");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  emit({ ok: false, code: "FAILED", error: message });
  process.exit(1);
});

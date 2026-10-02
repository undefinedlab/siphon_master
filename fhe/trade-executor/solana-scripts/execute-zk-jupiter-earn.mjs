/**
 * Settle a fired Devnet Jupiter Earn order: Groth16 spend → Earn deposit/withdraw → vault return.
 *
 * stdin JSON:
 *   venue: "jupiter-earn", action: "enter"|"exit",
 *   publics[25], proof_hex, binder_hex, nullifiers_hex[], circuit_index, mint, settlement,
 *   asset_mint, jl_token_mint, lending_program?,
 *   return?: { precommitment, user_salt }, recipient? (without return), resume?
 *
 * exit 0 EXECUTED | 3 NEEDS_REPROOF | 5 STAGED | 1 FAILED
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
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
const EARN_CU = 800_000;
const DEPOSIT_CU = 600_000;
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DOMAIN_VAULT_SCOPE = 3n;
const ERR_INVALID_COMMITMENT = 6022;

const LENDING_DEVNET = new PublicKey("7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3");
const LIQUIDITY_DEVNET = new PublicKey("5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL");
const DEFAULT_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const DEFAULT_JL = new PublicKey("2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");

const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const WITHDRAW_DISC = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);

function loadKeypair() {
  const raw = (process.env.SOLANA_RELAYER_KEYPAIR || "").trim();
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  if (raw && !raw.includes(path.sep) && raw.length > 80) {
    try {
      return Keypair.fromSecretKey(Buffer.from(raw, "base64"));
    } catch {
      /* fall through */
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
const mintField = (mint) => BigInt("0x" + Buffer.from(mint.toBytes()).toString("hex")) % FIELD_P;

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

function anchorCode(err) {
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(String(err?.message || err));
  return m ? parseInt(m[1], 16) : null;
}

const TREE_RING_OFF = 8 + 8 + 8 + 32 + 32 * 32 * 2;
function stateRootKnown(treeData, rootLe) {
  const len = treeData[9];
  for (let i = 0; i < len; i++) {
    const off = TREE_RING_OFF + i * 32;
    if (off + 32 <= treeData.length && treeData.subarray(off, off + 32).equals(rootLe)) return true;
  }
  return false;
}

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

const vaultNonce = (data) => data.readBigUInt64LE(73);
const vaultScope = (data) => leToField(data.subarray(146, 178));
const vaultVk = (data, i) => new PublicKey(data.subarray(178 + i * 32, 178 + i * 32 + 32));

function pda(programId, ...parts) {
  return PublicKey.findProgramAddressSync(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p instanceof PublicKey ? p.toBuffer() : p)),
    programId,
  )[0];
}

/** Resolve Devnet Earn accounts for an underlying asset mint. */
async function resolveEarnAccounts(connection, assetMint, lendingProgram) {
  const fTokenMint = pda(lendingProgram, "f_token_mint", assetMint);
  const lending = pda(lendingProgram, "lending", assetMint, fTokenMint);
  const lendingAdmin = pda(lendingProgram, "lending_admin");
  const liquidity = pda(LIQUIDITY_DEVNET, "liquidity");
  const supplyReserves = pda(LIQUIDITY_DEVNET, "reserve", assetMint);
  const supplyPos = pda(LIQUIDITY_DEVNET, "user_supply_position", assetMint, lending);
  const rateModel = pda(LIQUIDITY_DEVNET, "rate_model", assetMint);
  const vault = getAssociatedTokenAddressSync(assetMint, liquidity, true);

  const lendingInfo = await connection.getAccountInfo(lending, "confirmed");
  if (!lendingInfo) throw new Error(`Devnet Earn lending pool missing for ${assetMint.toBase58()}`);
  // Devnet rewards program (not mainnet jup7…); PDA seed lending_rewards_rate_model + asset.
  const REWARDS_RATE_MODEL_PROGRAM = new PublicKey("68LHLkpgjAvo6Lgd9FT6KYEX4FWn1911EohSXxHYMFjc");
  const rewardsRateModel = pda(REWARDS_RATE_MODEL_PROGRAM, "lending_rewards_rate_model", assetMint);
  if (!(await connection.getAccountInfo(rewardsRateModel, "confirmed"))) {
    throw new Error(`Devnet Earn rewards_rate_model missing for ${assetMint.toBase58()}`);
  }
  const claimAccount = pda(lendingProgram, "user_claim", assetMint, fTokenMint);
  return {
    fTokenMint,
    lending,
    lendingAdmin,
    liquidity,
    supplyReserves,
    supplyPos,
    rateModel,
    vault,
    rewardsRateModel,
    claimAccount,
    lendingProgram,
    liquidityProgram: LIQUIDITY_DEVNET,
  };
}

function buildDepositIx({ amount, signer, assetMint, earn, depositorAta, recipientJlAta }) {
  const data = Buffer.concat([DEPOSIT_DISC, u64Le(amount)]);
  return new TransactionInstruction({
    programId: earn.lendingProgram,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: depositorAta, isSigner: false, isWritable: true },
      { pubkey: recipientJlAta, isSigner: false, isWritable: true },
      { pubkey: assetMint, isSigner: false, isWritable: false },
      { pubkey: earn.lendingAdmin, isSigner: false, isWritable: false },
      { pubkey: earn.lending, isSigner: false, isWritable: true },
      { pubkey: earn.fTokenMint, isSigner: false, isWritable: true },
      { pubkey: earn.supplyReserves, isSigner: false, isWritable: true },
      { pubkey: earn.supplyPos, isSigner: false, isWritable: true },
      { pubkey: earn.rateModel, isSigner: false, isWritable: false },
      { pubkey: earn.vault, isSigner: false, isWritable: true },
      { pubkey: earn.liquidity, isSigner: false, isWritable: true },
      { pubkey: earn.liquidityProgram, isSigner: false, isWritable: true },
      { pubkey: earn.rewardsRateModel, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWithdrawIx({ amount, signer, assetMint, earn, ownerJlAta, recipientAta }) {
  const data = Buffer.concat([WITHDRAW_DISC, u64Le(amount)]);
  return new TransactionInstruction({
    programId: earn.lendingProgram,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: ownerJlAta, isSigner: false, isWritable: true },
      { pubkey: recipientAta, isSigner: false, isWritable: true },
      { pubkey: earn.lendingAdmin, isSigner: false, isWritable: false },
      { pubkey: earn.lending, isSigner: false, isWritable: true },
      { pubkey: assetMint, isSigner: false, isWritable: false },
      { pubkey: earn.fTokenMint, isSigner: false, isWritable: true },
      { pubkey: earn.supplyReserves, isSigner: false, isWritable: true },
      { pubkey: earn.supplyPos, isSigner: false, isWritable: true },
      { pubkey: earn.rateModel, isSigner: false, isWritable: false },
      { pubkey: earn.vault, isSigner: false, isWritable: true },
      { pubkey: earn.claimAccount, isSigner: false, isWritable: true },
      { pubkey: earn.liquidity, isSigner: false, isWritable: true },
      { pubkey: earn.liquidityProgram, isSigner: false, isWritable: true },
      { pubkey: earn.rewardsRateModel, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function main() {
  const pkg = await readStdin();
  if (pkg.venue && pkg.venue !== "jupiter-earn") fail("BAD_PACKAGE", "venue must be jupiter-earn");
  const action = String(pkg.action || "enter").toLowerCase() === "exit" ? "exit" : "enter";
  const publics = pkg.publics;
  if (!Array.isArray(publics) || publics.length !== 25) fail("BAD_PACKAGE", "publics must be 25 limbs");
  if (!pkg.proof_hex || pkg.proof_hex.length !== 512) fail("BAD_PACKAGE", "proof_hex must be 256 bytes");
  if (!pkg.binder_hex || pkg.binder_hex.length !== 64) fail("BAD_PACKAGE", "binder_hex must be 32 bytes");
  for (const k of ["settlement", "mint"]) if (!pkg[k]) fail("BAD_PACKAGE", `${k} required`);
  const ret = pkg.return || null;
  if (ret && (!ret.precommitment || !ret.user_salt || BigInt(ret.user_salt) === 0n)) {
    fail("BAD_PACKAGE", "return needs a precommitment and a non-zero user_salt");
  }
  if (!ret && !pkg.recipient) fail("BAD_PACKAGE", "recipient or return required");
  const screenUrl = (process.env.SOLASP_URL || "").replace(/\/$/, "");
  const screenToken = process.env.SOLASP_SCREEN_TOKEN || "";
  if (ret && (!screenUrl || !screenToken)) {
    fail("NO_SCREEN", "SOLASP_URL and SOLASP_SCREEN_TOKEN are required to return output to the vault");
  }

  const programId = new PublicKey(
    pkg.program_id || process.env.SIPHON_ZK_PROGRAM_ID || process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID,
  );
  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const payer = loadKeypair();
  const settlement = new PublicKey(pkg.settlement);
  if (!payer.publicKey.equals(settlement)) {
    fail("SETTLEMENT_MISMATCH", `proof settlement ${settlement.toBase58()} != relayer ${payer.publicKey.toBase58()}`);
  }

  const mintIn = new PublicKey(pkg.mint);
  const assetMint = new PublicKey(pkg.asset_mint || process.env.JUPITER_EARN_ASSET_MINT || DEFAULT_USDC.toBase58());
  const jlMint = new PublicKey(pkg.jl_token_mint || process.env.JUPITER_JL_USDC_MINT || DEFAULT_JL.toBase58());
  const lendingProgram = new PublicKey(pkg.lending_program || process.env.JUPITER_LEND_PROGRAM || LENDING_DEVNET.toBase58());
  const amountIn = BigInt(publics[5]);
  const outMint = action === "enter" ? jlMint : assetMint;
  const inAta = getAssociatedTokenAddressSync(mintIn, settlement, true);
  const outAta = getAssociatedTokenAddressSync(outMint, settlement, true);
  const jlAta = getAssociatedTokenAddressSync(jlMint, settlement, true);
  const usdcAta = getAssociatedTokenAddressSync(assetMint, settlement, true);

  const seed = (s, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], programId)[0];
  const vault = seed("siphon-vault-v1");
  const tree = seed("siphon-tree-v1");
  const compliance = seed("siphon-compliance-v1");

  const r = pkg.resume || {};
  const st = {
    stage: r.stage || "NEW",
    spend_sig: r.spend_sig,
    earn_sig: r.earn_sig,
    amount_in: amountIn.toString(),
    mint_in: mintIn.toBase58(),
    amount_out: r.amount_out,
    mint_out: outMint.toBase58(),
    action,
    deposit: r.deposit,
  };
  const staged = (err) =>
    fail("STAGED", err instanceof Error ? err.message : String(err), { resume: { ...st } });

  // ── 1. spend ──────────────────────────────────────────────────────────────────────────────
  if (st.stage === "NEW") {
    const nullifiers = (pkg.nullifiers_hex || []).map((h) => Buffer.from(h, "hex"));
    if (!nullifiers.length) fail("BAD_PACKAGE", "nullifiers_hex required");
    if (await connection.getAccountInfo(seed("siphon-nf-v1", nullifiers[0]), "confirmed")) {
      fail("SPENT_UNTRACKED", "this note was already spent and no resume state was given");
    }

    const [treeInfo, compInfo] = await connection.getMultipleAccountsInfo([tree, compliance], "confirmed");
    if (!treeInfo || !compInfo) fail("NO_VAULT", "ZK vault tree or compliance account missing");
    if (!stateRootKnown(treeInfo.data, fieldToLe32(publics[2]))) {
      fail("NEEDS_REPROOF", "the proof's state root has aged out of the vault's recent roots");
    }
    if (!complianceAccepts(compInfo.data, fieldToLe32(publics[3]), fieldToLe32(publics[4]))) {
      fail("NEEDS_REPROOF", "the proof's compliance roots are no longer accepted");
    }

    // Preflight: Earn accounts must exist before we spend.
    try {
      await resolveEarnAccounts(connection, assetMint, lendingProgram);
    } catch (err) {
      fail("NO_ROUTE", err instanceof Error ? err.message : String(err));
    }

    const binder = Buffer.from(pkg.binder_hex, "hex");
    const pending = seed("siphon-pending-inputs-v1", binder);
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
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, inAta, settlement, mintIn),
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: tree, isSigner: false, isWritable: true },
            { pubkey: compliance, isSigner: false, isWritable: false },
            { pubkey: pending, isSigner: false, isWritable: true },
            { pubkey: vaultVk(vaultInfo.data, circuitIndex), isSigner: false, isWritable: false },
            { pubkey: getAssociatedTokenAddressSync(mintIn, vault, true), isSigner: false, isWritable: true },
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
      const code = anchorCode(err);
      if (code === 6013 || code === 6014) fail("NEEDS_REPROOF", `spend rejected (${code}): roots moved`);
      if (!(await connection.getAccountInfo(seed("siphon-nf-v1", nullifiers[0]), "confirmed"))) throw err;
      st.spend_sig = "unconfirmed";
    }
    st.stage = "SPENT";
    emit({ stage: st.stage, resume: { ...st } });
  }

  // ── 2. Earn enter / exit ──────────────────────────────────────────────────────────────────
  if (st.stage === "SPENT") {
    try {
      const earn = await resolveEarnAccounts(connection, assetMint, lendingProgram);
      const setup = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: EARN_CU }),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, usdcAta, settlement, assetMint),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, jlAta, settlement, jlMint),
      ];
      if (action === "enter") {
        const before = await tokenBalance(connection, jlAta);
        const ix = buildDepositIx({
          amount: amountIn,
          signer: payer.publicKey,
          assetMint,
          earn,
          depositorAta: usdcAta,
          recipientJlAta: jlAta,
        });
        st.earn_sig = await send(connection, payer, [...setup, ix]);
        const got = (await tokenBalance(connection, jlAta)) - before;
        if (got <= 0n) throw new Error(`Earn deposit ${st.earn_sig} minted no jlUSDC`);
        st.amount_out = got.toString();
        st.mint_out = jlMint.toBase58();
      } else {
        const before = await tokenBalance(connection, usdcAta);
        // Withdraw by underlying amount; if spend was jl shares, redeem max via U64_MAX when amounts match shares.
        const jlBal = await tokenBalance(connection, jlAta);
        const withdrawAmt = jlBal < amountIn ? jlBal : amountIn;
        if (withdrawAmt <= 0n) throw new Error("no jlUSDC to redeem");
        const ix = buildWithdrawIx({
          amount: withdrawAmt,
          signer: payer.publicKey,
          assetMint,
          earn,
          ownerJlAta: jlAta,
          recipientAta: usdcAta,
        });
        st.earn_sig = await send(connection, payer, [...setup, ix]);
        const got = (await tokenBalance(connection, usdcAta)) - before;
        if (got <= 0n) throw new Error(`Earn withdraw ${st.earn_sig} produced no USDC`);
        st.amount_out = got.toString();
        st.mint_out = assetMint.toBase58();
      }
    } catch (err) {
      staged(err);
    }
    st.stage = "EARNED";
    emit({ stage: st.stage, resume: { ...st } });
  }

  // ── 3. return output to vault ─────────────────────────────────────────────────────────────
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
        connection,
        payer,
        programId,
        vault,
        tree,
        outMint,
        outAta,
        amountOut,
        ret,
        st,
        seed,
        screenUrl,
        screenToken,
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

  emit({
    ok: true,
    status: "EXECUTED",
    venue: "jupiter-earn",
    action,
    tx_hash: st.spend_sig,
    spend_sig: st.spend_sig,
    earn_sig: st.earn_sig,
    payout_sig: st.payout_sig,
    mint_in: st.mint_in,
    mint_out: st.mint_out,
    amount_in: st.amount_in,
    amount_out: st.amount_out,
    returned_note: note,
  });
}

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
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          getAssociatedTokenAddressSync(outMint, vault, true),
          vault,
          outMint,
        ),
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
    }
  }
  throw new Error("lost the deposit-nonce race four times");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  emit({ ok: false, code: "FAILED", error: message });
  process.exit(1);
});

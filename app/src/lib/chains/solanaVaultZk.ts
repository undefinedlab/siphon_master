/**
 * Siphon Solana Devnet ZK vault client (`siphon-contracts-v2/solana/programs/siphon-vault-zk`).
 *
 * Replaces the legacy FHE vault as the product path: Poseidon depth-32 tree, Groth16 over
 * alt_bn128, commit-then-spend (25 public limbs live in a pending PDA, the spend tx carries only
 * the 256-byte proof). The legacy client in `solanaVaultOnchain.ts` stays exported for archaeology.
 *
 * Encodings (all mirrored from `siphon-vault-zk/src/{lib,poseidon,verify}.rs`):
 *   - public limbs, commitments, userSalt, precommitment, vault_scope_id : 32-byte LITTLE-endian field
 *   - mint pubkey / program id / vault PDA / raw payee                   : 32-byte BIG-endian field
 *   - proof                                                              : A(64) || B(128) || C(64), BE
 *     The program negates A itself (`verify::negate_proof_a_be`), so the client sends snarkjs A raw.
 */
import { solanaZkProgramId } from "@/lib/chains/solanaZkProgram";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";
import {
  formatAspDenyMessage,
  isKytFeeRequired,
  KytFeeRequiredError,
} from "@/lib/sanctionsScreen";
import {
  DEVNET_JL_USDC_MINT,
  DEVNET_USDC_MINT,
  LEGACY_FHE_PROGRAM_ID,
  getDevnetConnection,
  ixDiscriminator,
  signSendConfirm,
  type PhantomLike,
  type SolanaNativeDepositResult,
} from "@/lib/chains/solanaVaultOnchain";
import {
  deleteSolanaNotesNotInLeaves,
  filterNotesInLeaves,
  getSolanaNoteEncKey,
  isSpendableSolanaNote,
  loadSolanaNotes,
  markSolanaNoteSpent,
  saveSolanaNote,
  solanaSymbolForMint,
  type SolanaStoredNote,
} from "@/lib/chains/solanaNoteStore";
import { zkUrl } from "@/lib/zkAssets";
import {
  assetIdFromSolanaMint,
  hashCommitmentWithPre,
  hashPrecommitment,
  mintLabelSalted,
  modField,
  randomUserSalt,
  vaultScopeIdSolana,
} from "@/lib/v3/noteCryptoV3";
import { PROGRAM_VERSION_V3, zkProvingBase } from "@/lib/v3/configV3";
import { planWithdraw, type PlannerNote } from "@/lib/v3/planWithdrawV3";
import { buildStatePath, computeStateRoot, findLeafIndex, TREE_DEPTH } from "@/lib/v3/stateTreeV3";
import { buildWithdrawWitness } from "@/lib/v3/withdrawWitnessV3";
import { proveSpend } from "@/lib/v3/proveRemote";
import { deriveSplitPublics, MAX_SPLIT_OUTPUTS, type SplitSlice } from "@/lib/v3/actionPublicsV3";
import { splitWitnessInput } from "@/lib/v3/spendActionsV3";
import { loadComplianceWitnessMulti } from "@/lib/v3/aspClientV3";
import { randomLabelSalt } from "@/lib/v3/complianceProofV3";

export { LEGACY_FHE_PROGRAM_ID };

// ───────────────────────────────────────────────────────────────────────────── mode / program id

/**
 * Literal member expressions so Next inlines them at build time (see v3/configV3.ts ENV note).
 */
function envProgramId(): string {
  return solanaZkProgramId();
}
function envZkFlag(): boolean {
  return (process.env.NEXT_PUBLIC_SIPHON_SOLANA_ZK || "").trim() === "1";
}

/**
 * ZK mode is on when explicitly flagged, or when the program id is anything other than the legacy
 * FHE vault. Unset now resolves to the deployed ZK program (solanaZkProgram.ts), so the default is ZK.
 */
export function isSolanaZkMode(): boolean {
  if (envZkFlag()) return true;
  const id = envProgramId();
  return id !== "" && id !== LEGACY_FHE_PROGRAM_ID;
}

/** True when ZK mode is on AND a ZK program id is actually configured (i.e. calls can succeed). */
export function isSolanaZkConfigured(): boolean {
  const id = envProgramId();
  return isSolanaZkMode() && id !== "" && id !== LEGACY_FHE_PROGRAM_ID;
}

/** The deployed ZK program. Throws (rather than silently hitting the legacy program) if unset. */
export function getZkProgramId(): PublicKey {
  const id = envProgramId();
  if (!id || id === LEGACY_FHE_PROGRAM_ID) {
    throw new Error(
      "Solana ZK vault is not deployed/configured: set NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID to the " +
        "siphon-vault-zk program id (it must differ from the legacy FHE program).",
    );
  }
  return new PublicKey(id);
}

// ───────────────────────────────────────────────────────────────────────────── seeds / PDAs

const enc = (s: string) => new TextEncoder().encode(s);
export const ZK_VAULT_SEED = enc("siphon-vault-v1");
export const ZK_COMPLIANCE_SEED = enc("siphon-compliance-v1");
export const ZK_PENDING_SEED = enc("siphon-pending-inputs-v1");
export const ZK_TREE_SEED = enc("siphon-tree-v1");
export const ZK_NULLIFIER_SEED = enc("siphon-nf-v1");
export const ZK_LEAF_SEED = enc("siphon-leaf-v1");

export const NR_PUBLIC_INPUTS = 25;
export const PROOF_BYTES = 256;
export const NULLIFIER_START = 9;
/** `lib.rs::VK_SLOT_COUNT` — order of `export-vk-accounts.mjs::CIRCUITS`. */
export const VK_SLOT_COUNT = 14;
/** Spend verifies a 25-limb pairing + inserts into a depth-32 Poseidon tree: well past the 200k default. */
export const SPEND_COMPUTE_UNITS = 1_400_000;

const pda = (seeds: Uint8Array[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId);

export function zkVaultPda(programId: PublicKey = getZkProgramId()): [PublicKey, number] {
  return pda([ZK_VAULT_SEED], programId);
}
export function zkTreePda(programId: PublicKey = getZkProgramId()): [PublicKey, number] {
  return pda([ZK_TREE_SEED], programId);
}
export function zkCompliancePda(programId: PublicKey = getZkProgramId()): [PublicKey, number] {
  return pda([ZK_COMPLIANCE_SEED], programId);
}
/** Pending publics PDA for a spend, keyed by the caller-chosen binder. */
export function zkPendingPda(
  binder: Uint8Array,
  programId: PublicKey = getZkProgramId(),
): [PublicKey, number] {
  return pda([ZK_PENDING_SEED, binder], programId);
}
/** Nullifier burn marker; `nf` is the public nullifier-hash limb (LE 32 bytes). */
export function zkNullifierPda(
  nf: Uint8Array,
  programId: PublicKey = getZkProgramId(),
): [PublicKey, number] {
  return pda([ZK_NULLIFIER_SEED, nf], programId);
}
/** `commitment -> leaf_index` lookup PDA written by `deposit`; `commitment` is the LE limb. */
export function zkLeafPda(
  commitment: Uint8Array,
  programId: PublicKey = getZkProgramId(),
): [PublicKey, number] {
  return pda([ZK_LEAF_SEED, commitment], programId);
}

// ───────────────────────────────────────────────────────────────────────────── byte helpers

export function fieldToLe32(x: bigint): Uint8Array {
  let v = modField(x);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function leToField(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bigToBe32(x: bigint): Uint8Array {
  let v = x;
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function u64Le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── on-chain state

/** `VaultAccount` (Anchor, 8-byte discriminator first). */
export type ZkVaultState = {
  bump: number;
  authority: PublicKey;
  programVersion: Uint8Array;
  depositNonce: bigint;
  stateRoot: Uint8Array;
  depositsPaused: boolean;
  allowedMint: PublicKey;
  vaultScopeId: Uint8Array;
  vkAccounts: PublicKey[];
};

export async function fetchZkVaultState(
  connection: Connection = getDevnetConnection(),
  programId: PublicKey = getZkProgramId(),
): Promise<ZkVaultState> {
  const [vault] = zkVaultPda(programId);
  const info = await connection.getAccountInfo(vault, "confirmed");
  if (!info) throw new Error("Solana ZK vault is not initialized on this cluster.");
  const d = info.data;
  const vkAccounts: PublicKey[] = [];
  for (let i = 0; i < VK_SLOT_COUNT; i++) {
    vkAccounts.push(new PublicKey(d.subarray(178 + i * 32, 210 + i * 32)));
  }
  return {
    bump: d[8],
    authority: new PublicKey(d.subarray(9, 41)),
    programVersion: Uint8Array.from(d.subarray(41, 73)),
    depositNonce: d.readBigUInt64LE(73),
    stateRoot: Uint8Array.from(d.subarray(81, 113)),
    depositsPaused: d[113] !== 0,
    allowedMint: new PublicKey(d.subarray(114, 146)),
    vaultScopeId: Uint8Array.from(d.subarray(146, 178)),
    vkAccounts,
  };
}

/** `TreeAccount` head: next_index + current root (LE limb). */
export async function fetchZkTreeHead(
  connection: Connection = getDevnetConnection(),
  programId: PublicKey = getZkProgramId(),
): Promise<{ nextIndex: bigint; root: Uint8Array }> {
  const [tree] = zkTreePda(programId);
  const info = await connection.getAccountInfo(tree, "confirmed");
  if (!info) throw new Error("Solana ZK note tree is not initialized.");
  return {
    nextIndex: info.data.readBigUInt64LE(16),
    root: Uint8Array.from(info.data.subarray(24, 56)),
  };
}

/** `ComplianceAccount`: the admitted/revoked roots every spend must carry in limbs 3/4. */
export async function fetchZkComplianceRoots(
  connection: Connection = getDevnetConnection(),
  programId: PublicKey = getZkProgramId(),
): Promise<{ admittedRoot: Uint8Array; revokedRoot: Uint8Array }> {
  const [c] = zkCompliancePda(programId);
  const info = await connection.getAccountInfo(c, "confirmed");
  if (!info) throw new Error("Solana ZK compliance roots have not been set by the vault authority.");
  return {
    admittedRoot: Uint8Array.from(info.data.subarray(9, 41)),
    revokedRoot: Uint8Array.from(info.data.subarray(41, 73)),
  };
}

// ───────────────────────────────────────────────────────────────────────────── deposit

export type ZkDepositNote = {
  note: SolanaStoredNote;
  /** LE limbs sent on-chain. */
  userSalt: Uint8Array;
  precommitment: Uint8Array;
  commitment: Uint8Array;
};

/**
 * Derive a fresh note exactly as `deposit_flow::execute_deposit` / `lib.rs::deposit` will:
 *   label      = H(H(DOMAIN_VAULT_SCOPE, scope, nonce), userSalt)
 *   commitment = H(H(amount, label, BE(mint)), precommitment)
 * The caller must pass the vault's CURRENT `deposit_nonce`; if another deposit lands first the leaf
 * PDA seed no longer matches and the program rejects the tx (retry with a fresh nonce).
 */
export async function buildZkDepositNote(params: {
  amount: bigint;
  mint: PublicKey;
  depositNonce: bigint;
  programId?: PublicKey;
  /** On-chain `vault_scope_id` (LE). Cross-checked against the locally derived value. */
  vaultScopeIdLe?: Uint8Array;
}): Promise<ZkDepositNote> {
  const programId = params.programId ?? getZkProgramId();
  const [vault] = zkVaultPda(programId);
  const scope = await vaultScopeIdSolana(programId.toBytes(), vault.toBytes());
  if (params.vaultScopeIdLe && leToField(params.vaultScopeIdLe) !== scope) {
    throw new Error("ZK vault scope mismatch: on-chain vault_scope_id != Poseidon(program, vault PDA).");
  }

  const nullifier = randomUserSalt();
  const secret = randomUserSalt();
  const userSalt = randomUserSalt();
  const precommitment = await hashPrecommitment(nullifier, secret);
  const label = await mintLabelSalted(scope, params.depositNonce, userSalt);
  const assetId = assetIdFromSolanaMint(params.mint.toBytes());
  const commitment = await hashCommitmentWithPre(params.amount, label, assetId, precommitment);

  const commitmentLe = fieldToLe32(commitment);
  const mint = params.mint.toBase58();
  const note: SolanaStoredNote = {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    label: label.toString(),
    assetId: assetId.toString(),
    mint,
    symbol: solanaSymbolForMint(mint),
    commitment: commitment.toString(),
    commitmentHex: bytesToHex(commitmentLe),
    value: params.amount.toString(),
    precommitment: precommitment.toString(),
    userSalt: userSalt.toString(),
    spent: false,
  };
  return {
    note,
    userSalt: fieldToLe32(userSalt),
    precommitment: fieldToLe32(precommitment),
    commitment: commitmentLe,
  };
}

/** Wallet-auth and request errors. These are not "the ASP module is unwired". */
const ASP_CLIENT_ERRORS = new Set([
  "wallet_auth_invalid",
  "wallet_auth_expired",
  "wallet_auth_required",
  "origin_forbidden",
  "origin_required",
  "invalid_json",
  "invalid_request",
  "invalid_body",
  "rate_limited",
]);

function aspScreenDetail(body: { decision?: string; error?: string; message?: string }, status: number): string {
  const why = body.decision || body.error || `HTTP ${status}`;
  return body.message ? `${why}: ${body.message}` : why;
}

/**
 * Screen the depositor with the chain's ASP (siphon-solasp) via the same-origin proxy, signed with
 * Phantom.
 *
 * A real `deny` still blocks the deposit. When the Solana ASP is not wired — missing
 * `ASP_SCREEN_TOKEN_900002`, a bad `ASP_URL_900002`, or the host is down — and
 * Always required for Solana ZK: without a PendingAdmit the watcher/admit-heal cannot put the
 * label in the association set, and withdraw fails with "asp path: label … not member".
 */
export async function screenSolanaZkDeposit(
  depositor: string,
  commitment: string,
  userSalt: string,
): Promise<void> {
  const { fetchWithSolanaAuth } = await import("@/lib/solanaWalletAuth");
  let res: Response;
  try {
    res = await fetchWithSolanaAuth("/api/asp-screen", {
      method: "POST",
      body: JSON.stringify({ chainId: SOLANA_DEVNET_CHAIN_ID, depositor, commitment, userSalt }),
    });
  } catch (e) {
    // ZK notes are unspendable without ASP membership — never skip on Devnet.
    throw new Error(
      `ASP screen did not admit this wallet (${e instanceof Error ? e.message : "unreachable"})`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as {
    decision?: string;
    error?: string;
    message?: string;
    reasons?: unknown;
  };
  const reasons = Array.isArray(body.reasons)
    ? body.reasons.filter((r): r is string => typeof r === "string")
    : [];

  if (res.ok && body.decision === "admit") return;
  if (body.decision === "deny") {
    throw new Error(formatAspDenyMessage(reasons));
  }
  if (isKytFeeRequired(res.status, reasons)) {
    throw new KytFeeRequiredError();
  }
  if (body.decision === "pending") {
    const why = reasons.length ? reasons.join(", ") : "dependency pending";
    throw new Error(`Deposit screening is temporarily pending (${why}). Try again shortly.`);
  }

  // ZK spend proves ASP membership. Skipping screen (fail-open) deposits notes that can never
  // be withdrawn — that is how Devnet ended up with admittedLeafCount:0 and
  // "asp path: label … not member". Always fail closed for Solana ZK.
  throw new Error(`ASP screen did not admit this wallet (${aspScreenDetail(body, res.status)})`);
}

/**
 * Ensure each note's label is in the ASP association set before proving a spend.
 * Re-screens + admits via solasp when the watcher never ran (common on Devnet).
 */
export async function ensureSolanaNotesAdmitted(
  owner: string,
  notes: SolanaStoredNote[],
  onStatus?: (message: string) => void,
): Promise<void> {
  const say = onStatus ?? (() => undefined);
  const { fetchWithSolanaAuth } = await import("@/lib/solanaWalletAuth");
  const seen = new Set<string>();
  for (const note of notes) {
    const label = String(note.label);
    if (seen.has(label)) continue;
    seen.add(label);

    const memberRes = await fetchWithSolanaAuth(
      `/api/asp-set/member?label=${encodeURIComponent(label)}&chainId=${SOLANA_DEVNET_CHAIN_ID}`,
      { method: "GET" },
    );
    const member = (await memberRes.json().catch(() => ({}))) as { admitted?: boolean; member?: boolean };
    if (memberRes.ok && (member.admitted || member.member)) continue;

    if (!note.depositSig) {
      throw new Error(
        `Note label ${label.slice(0, 12)}… is not ASP-admitted and has no deposit signature to heal.`,
      );
    }
    say("Admitting deposit into the association set…");
    await screenSolanaZkDeposit(owner, note.commitment, note.userSalt);
    const admitRes = await fetchWithSolanaAuth("/api/solana/admit-deposit", {
      method: "POST",
      body: JSON.stringify({
        chainId: SOLANA_DEVNET_CHAIN_ID,
        depositor: owner,
        commitment: note.commitment,
        userSalt: note.userSalt,
        signature: note.depositSig,
        label: note.label,
      }),
    });
    const admitBody = (await admitRes.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
    };
    if (!admitRes.ok || admitBody.ok === false) {
      const why = admitBody.message || admitBody.error || `HTTP ${admitRes.status}`;
      throw new Error(
        `ASP will not admit this deposit (${why}). Redeploy solasp with /solana/admit-deposit, ` +
          `or run the Solana deposit watcher + postman so labels enter the association set.`,
      );
    }
  }
}

/**
 * Root-keyed leaf cache. Strategy arm + withdraw + split each need the full ordered tree; without
 * this, a single indexer miss regenerates it via getSignaturesForAddress + getTransaction-per-sig
 * against public Devnet RPC and trips "too many requests" mid-prove.
 */
type SolanaLeavesCache = { root: string; nextIndex: number; leaves: bigint[] };
let solanaLeavesCache: SolanaLeavesCache | null = null;
let solanaLeavesInflight: Promise<bigint[]> | null = null;

/** Drop the cached leaf list (after a deposit/spend that inserts a leaf). */
export function invalidateSolanaStateLeavesCache(): void {
  solanaLeavesCache = null;
  solanaLeavesInflight = null;
}

function cacheSolanaLeaves(head: { nextIndex: bigint; root: Uint8Array }, leaves: bigint[]): bigint[] {
  solanaLeavesCache = {
    root: bytesToHex(head.root),
    nextIndex: Number(head.nextIndex),
    leaves,
  };
  return leaves;
}

function cachedSolanaLeavesIfFresh(head: { nextIndex: bigint; root: Uint8Array }): bigint[] | null {
  const hit = solanaLeavesCache;
  if (!hit) return null;
  if (hit.root !== bytesToHex(head.root) || hit.nextIndex !== Number(head.nextIndex)) return null;
  if (hit.leaves.length !== Number(head.nextIndex)) return null;
  return hit.leaves;
}

/** Ordered state leaves — memory → localStorage → `/api/solana/leaves` (ASP DB or shared server rebuild). */
export async function fetchZkStateLeavesFromIndexer(): Promise<bigint[]> {
  if (solanaLeavesInflight) return solanaLeavesInflight;
  const task = (async () => {
    const connection = getDevnetConnection();
    const head = await fetchZkTreeHead(connection, getZkProgramId());
    const rootHex = bytesToHex(head.root);
    const nextIndex = Number(head.nextIndex);

    const mem = cachedSolanaLeavesIfFresh(head);
    if (mem) return mem;

    const { readSolLeavesLocal, writeSolLeavesLocal } = await import("@/lib/chains/solanaLeavesStore");
    const local = readSolLeavesLocal(rootHex, nextIndex);
    if (local) {
      const root = await computeStateRoot(local);
      if (root === leToField(head.root)) return cacheSolanaLeaves(head, local);
    }

    // Browsers must NOT walk vault history: that is what 429'd withdraw. The API serves ASP's
    // Postgres when complete, otherwise one shared server-side rebuild cached by root.
    // Server-side (pipeline-prove / TEE): call ASP directly — relative `/api/...` is invalid in Node
    // (`Failed to parse URL from /api/solana/leaves`) and the leaves route also rejects non-browser origins.
    let res: Response;
    let body: { leaves?: string[]; error?: string; message?: string };
    if (typeof window === "undefined") {
      const { aspBaseUrl, aspProxyHeaders } = await import("@/lib/aspServerUrl");
      const base = aspBaseUrl(SOLANA_DEVNET_CHAIN_ID);
      if (!base) {
        throw new Error("State-tree leaves unavailable (asp_unconfigured on server).");
      }
      res = await fetch(`${base}/solana/state/leaves?chainId=${SOLANA_DEVNET_CHAIN_ID}`, {
        headers: aspProxyHeaders(base, {}, SOLANA_DEVNET_CHAIN_ID),
        signal: AbortSignal.timeout(30_000),
      });
      body = (await res.json().catch(() => ({}))) as {
        leaves?: string[];
        error?: string;
        message?: string;
      };
    } else {
      res = await fetch("/api/solana/leaves", { method: "GET" });
      body = (await res.json().catch(() => ({}))) as {
        leaves?: string[];
        error?: string;
        message?: string;
      };
    }
    if (!res.ok || !Array.isArray(body.leaves)) {
      const why =
        [body.error, body.message].filter(Boolean).join(": ") || `HTTP ${res.status}`;
      if (res.status === 429 || /rate_limited/i.test(why)) {
        throw new Error("State-tree leaves rate-limited — retry in a moment.");
      }
      throw new Error(
        `State-tree leaves unavailable (${why}). Private notes are local; public leaves come from ` +
          `solasp / the shared server cache — not from this browser scanning Devnet RPC.`,
      );
    }
    const leaves = body.leaves.map((x) => BigInt(x));
    if (leaves.length !== nextIndex) {
      throw new Error(
        `State-tree leaves stale: got ${leaves.length}, on-chain nextIndex is ${nextIndex}. Retry shortly.`,
      );
    }
    const root = await computeStateRoot(leaves);
    if (root !== leToField(head.root)) {
      throw new Error("State-tree leaves do not match the on-chain root — refusing to prove.");
    }
    writeSolLeavesLocal(rootHex, nextIndex, leaves);
    return cacheSolanaLeaves(head, leaves);
  })().finally(() => {
    solanaLeavesInflight = null;
  });
  solanaLeavesInflight = task;
  return task;
}

/** `deposit(amount, user_salt, precommitment)`. Account order = `Deposit<'info>`. */
export async function buildDepositIx(params: {
  depositor: PublicKey;
  amount: bigint;
  userSalt: Uint8Array;
  precommitment: Uint8Array;
  /** LE commitment — seeds the leaf PDA. */
  commitment: Uint8Array;
  mint: PublicKey;
  programId?: PublicKey;
}): Promise<{ ix: TransactionInstruction; leaf: PublicKey; vault: PublicKey }> {
  const programId = params.programId ?? getZkProgramId();
  const [vault] = zkVaultPda(programId);
  const [tree] = zkTreePda(programId);
  const [leaf] = zkLeafPda(params.commitment, programId);
  const depositorToken = getAssociatedTokenAddressSync(params.mint, params.depositor);
  const vaultToken = getAssociatedTokenAddressSync(params.mint, vault, true);
  const disc = await ixDiscriminator("deposit");
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.depositor, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: depositorToken, isSigner: false, isWritable: true },
      { pubkey: vaultToken, isSigner: false, isWritable: true },
      { pubkey: leaf, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concat(
        disc,
        u64Le(params.amount),
        params.userSalt,
        params.precommitment,
        params.commitment,
      ),
    ),
  });
  return { ix, leaf, vault };
}

async function readLeafIndex(
  connection: Connection,
  leaf: PublicKey,
): Promise<number | undefined> {
  try {
    const info = await connection.getAccountInfo(leaf, "confirmed");
    if (!info || info.data.length < 17) return undefined;
    return Number(info.data.readBigUInt64LE(9));
  } catch {
    return undefined;
  }
}

/**
 * Shared deposit path. The note is persisted BEFORE the tx is sent: the vault keeps no plaintext
 * record, so a crash between confirm and save would strand the funds. It is stored pending (no
 * `depositSig`, excluded from balances) and promoted once the tx confirms.
 */
async function depositZk(params: {
  phantom: PhantomLike;
  amount: bigint;
  mint: PublicKey;
  /** Extra instructions placed before the deposit ix (WSOL wrap). */
  pre?: TransactionInstruction[];
}): Promise<SolanaNativeDepositResult> {
  if (params.amount <= 0n) throw new Error("Enter a valid amount.");
  const programId = getZkProgramId();
  const connection = getDevnetConnection();
  const depositor = new PublicKey(params.phantom.publicKey.toBytes());
  const owner = depositor.toBase58();

  const vault = await fetchZkVaultState(connection, programId);
  if (vault.depositsPaused) throw new Error("Deposits are paused on the Solana ZK vault.");
  const mintOk =
    params.mint.equals(NATIVE_MINT) ||
    params.mint.equals(DEVNET_JL_USDC_MINT) ||
    vault.allowedMint.equals(params.mint);
  if (!mintOk) {
    throw new Error(
      `This ZK vault accepts USDC (${vault.allowedMint.toBase58()}), WSOL, or jlUSDC (${DEVNET_JL_USDC_MINT.toBase58()}); ` +
        `tried ${params.mint.toBase58()}.`,
    );
  }

  // Unlock the note store first: a declined signature must fail before any funds move.
  await getSolanaNoteEncKey(owner);

  const built = await buildZkDepositNote({
    amount: params.amount,
    mint: params.mint,
    depositNonce: vault.depositNonce,
    programId,
    vaultScopeIdLe: vault.vaultScopeId,
  });
  const { ix, leaf } = await buildDepositIx({
    depositor,
    amount: params.amount,
    userSalt: built.userSalt,
    precommitment: built.precommitment,
    commitment: built.commitment,
    mint: params.mint,
    programId,
  });

  // ASP screen BEFORE funds move when solasp is up: it records the pending admit the watcher
  // matches to this deposit. A missing token or dead ASP URL is an unwired module, not a deny —
  // screenSolanaZkDeposit continues in that case when fail-closed is off.
  await screenSolanaZkDeposit(owner, built.note.commitment, built.note.userSalt);

  await saveSolanaNote(owner, built.note); // pending

  const tx = new Transaction();
  for (const p of params.pre ?? []) tx.add(p);
  tx.add(ix);
  const signature = await signSendConfirm(params.phantom, connection, tx);

  const leafIndex = await readLeafIndex(connection, leaf);
  await saveSolanaNote(owner, { ...built.note, depositSig: signature, leafIndex });
  invalidateSolanaStateLeavesCache();

  return {
    signature,
    commitmentHex: built.note.commitmentHex,
    notePubkey: leaf.toBase58(),
    amount: params.amount.toString(),
    chainId: SOLANA_DEVNET_CHAIN_ID,
    mint: params.mint.toBase58(),
  };
}

/** Deposit Devnet USDC into the ZK vault (Poseidon commitment, encrypted local note). */
export async function depositUsdcZk(params: {
  phantom: PhantomLike;
  amountBaseUnits: bigint;
  mint?: PublicKey;
}): Promise<SolanaNativeDepositResult> {
  // Prefer the vault's on-chain allowed mint over the env default so deposit notes and
  // withdraw coin-selection always bind the same mint / assetId.
  const mint =
    params.mint ??
    (await fetchZkVaultState(getDevnetConnection(), getZkProgramId())).allowedMint ??
    DEVNET_USDC_MINT;
  return depositZk({
    phantom: params.phantom,
    amount: params.amountBaseUnits,
    mint,
  });
}

/** Wrap SOL to WSOL and deposit it in one Phantom approval (requires a WSOL-allowed vault). */
export async function depositWsolZk(params: {
  phantom: PhantomLike;
  lamports: bigint;
}): Promise<SolanaNativeDepositResult> {
  if (params.lamports <= 0n) throw new Error("Enter a valid SOL amount.");
  if (params.lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount too large.");
  const connection = getDevnetConnection();
  const depositor = new PublicKey(params.phantom.publicKey.toBytes());
  const balance = await connection.getBalance(depositor, "confirmed");
  const need = Number(params.lamports) + 50_000_000; // fees + ATA rent + headroom
  if (balance < need) {
    let tip =
      " Get Devnet SOL from https://faucet.solana.com (mainnet SOL does not work here).";
    try {
      const { Connection } = await import("@solana/web3.js");
      const main = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
      const mainBal = await main.getBalance(depositor, "confirmed");
      if (mainBal >= need) {
        tip =
          " Phantom is funded on mainnet — this vault needs Devnet SOL. " +
          "Settings → Developer Settings → Testnet Mode → Solana Devnet, then use a Devnet faucet.";
      }
    } catch {
      /* ignore */
    }
    throw new Error(
      `Not enough Devnet SOL: need ~${(need / 1e9).toFixed(4)} SOL, Devnet balance ${(balance / 1e9).toFixed(4)} SOL.${tip}`,
    );
  }
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, depositor);
  return depositZk({
    phantom: params.phantom,
    amount: params.lamports,
    mint: NATIVE_MINT,
    pre: [
      createAssociatedTokenAccountIdempotentInstruction(depositor, userWsol, depositor, NATIVE_MINT),
      SystemProgram.transfer({
        fromPubkey: depositor,
        toPubkey: userWsol,
        lamports: Number(params.lamports),
      }),
      createSyncNativeInstruction(userWsol),
    ],
  });
}

// ───────────────────────────────────────────────────────────────────────────── commit + spend

/** `commit_public_inputs(binder, publics[25])`. Limbs are decimal strings → 32-byte LE. */
export async function buildCommitPublicInputsIx(params: {
  payer: PublicKey;
  binder: Uint8Array;
  publics: Array<string | bigint>;
  programId?: PublicKey;
}): Promise<{ ix: TransactionInstruction; pending: PublicKey }> {
  if (params.binder.length !== 32) throw new Error("binder must be 32 bytes");
  if (params.publics.length !== NR_PUBLIC_INPUTS) {
    throw new Error(`expected ${NR_PUBLIC_INPUTS} public limbs, got ${params.publics.length}`);
  }
  const programId = params.programId ?? getZkProgramId();
  const [vault] = zkVaultPda(programId);
  const [pending] = zkPendingPda(params.binder, programId);
  const disc = await ixDiscriminator("commit_public_inputs");
  const limbs = params.publics.map((p) => fieldToLe32(BigInt(p)));
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: pending, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(disc, params.binder, ...limbs)),
  });
  return { ix, pending };
}

/**
 * G2 limb order inside proof B. Light/groth16-solana and the EVM precompile want
 * `x.c1 || x.c0 || y.c1 || y.c0`; snarkjs emits `[c0, c1]`, so they are swapped here — the same swap
 * `withdrawV3.proofToCalldata` does for Solidity and `export-vk-accounts.mjs::g2ToBytes` for VKs.
 */
export const PROOF_G2_C1_FIRST = true;

type SnarkjsProof = { pi_a: string[]; pi_b: string[][]; pi_c: string[] };

/**
 * snarkjs Groth16 proof → the program's 256-byte layout `A(64) || B(128) || C(64)`, big-endian.
 * A is NOT negated here: `verify_proof` negates it on-chain (see VERIFY-RESEARCH.md open verify #2).
 */
export function packProofFromSnarkjs(proof: SnarkjsProof): Uint8Array {
  const be = (v: string) => bigToBe32(BigInt(v));
  const g2 = (p: string[]) => (PROOF_G2_C1_FIRST ? [be(p[1]), be(p[0])] : [be(p[0]), be(p[1])]);
  const out = concat(
    be(proof.pi_a[0]),
    be(proof.pi_a[1]),
    ...g2(proof.pi_b[0]),
    ...g2(proof.pi_b[1]),
    be(proof.pi_c[0]),
    be(proof.pi_c[1]),
  );
  if (out.length !== PROOF_BYTES) throw new Error(`packProof: expected ${PROOF_BYTES} bytes`);
  return out;
}

/** Circuit slot index = position in `export-vk-accounts.mjs::CIRCUITS` / `lib.rs::VK_SLOT_COUNT`. */
const CIRCUIT_SLOT: Record<string, number> = {
  withdraw1: 0,
  withdraw2: 1,
  withdraw3: 2,
  withdraw4: 3,
  withdraw5: 4,
  withdraw6: 5,
  merge2: 6,
  merge3: 7,
  merge4: 8,
  merge5: 9,
  merge6: 10,
  swap: 11,
  split: 12,
  ragequit: 13,
};
export function circuitSlot(circuit: string): number {
  const i = CIRCUIT_SLOT[circuit];
  if (i === undefined) throw new Error(`unknown circuit ${circuit}`);
  return i;
}

/**
 * `spend(proof, raw_payee, circuit_index)`. Account order = `Spend<'info>`, followed by one
 * writable nullifier PDA per used input (`remaining_accounts[i]`).
 *
 * The withdrawn amount is not an argument: the program reads it from pending publics limb 5 and
 * checks the payee against limb 15. `mint` must be the vault's `allowed_mint`.
 */
export async function buildSpendIx(params: {
  spender: PublicKey;
  binder: Uint8Array;
  proof: Uint8Array;
  rawPayee: Uint8Array;
  circuitIndex: number;
  /** Public nullifier-hash limbs actually used (publics[9..9+inputCount]), 32-byte LE each. */
  nullifiers: Uint8Array[];
  /** `vault.vk_accounts[circuitIndex]`. */
  vkAccount: PublicKey;
  mint: PublicKey;
  programId?: PublicKey;
}): Promise<{ ix: TransactionInstruction; payeeToken: PublicKey }> {
  if (params.proof.length !== PROOF_BYTES) throw new Error(`proof must be ${PROOF_BYTES} bytes`);
  if (params.rawPayee.length !== 32) throw new Error("rawPayee must be 32 bytes");
  const programId = params.programId ?? getZkProgramId();
  const [vault] = zkVaultPda(programId);
  const [tree] = zkTreePda(programId);
  const [compliance] = zkCompliancePda(programId);
  const [pending] = zkPendingPda(params.binder, programId);
  const vaultToken = getAssociatedTokenAddressSync(params.mint, vault, true);
  const payeeToken = getAssociatedTokenAddressSync(params.mint, new PublicKey(params.rawPayee), true);
  const disc = await ixDiscriminator("spend");
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.spender, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: compliance, isSigner: false, isWritable: false },
      { pubkey: pending, isSigner: false, isWritable: true },
      { pubkey: params.vkAccount, isSigner: false, isWritable: false },
      { pubkey: vaultToken, isSigner: false, isWritable: true },
      { pubkey: payeeToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...Array.from({ length: 6 }, (_, i) => {
        const nf = params.nullifiers[i];
        return {
          // Unused slots still need `mut`; program id is not writable (Anchor ConstraintMut).
          pubkey: nf ? zkNullifierPda(nf, programId)[0] : params.spender,
          isSigner: false,
          isWritable: true,
        };
      }),
    ],
    data: Buffer.from(
      concat(
        disc,
        params.binder,
        params.proof,
        params.rawPayee,
        Uint8Array.of(params.circuitIndex),
      ),
    ),
  });
  return { ix, payeeToken };
}

// ───────────────────────────────────────────────────────────────────────────── state leaves

const DEPOSIT_EVENT_FIELDS = 32 + 32 + 32 + 8 + 8; // depositor, mint, commitment, leaf_index, nonce

async function eventDiscriminator(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", enc(`event:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

const LEAF_INSERTED_FIELDS = 32 + 8; // commitment + leaf_index

async function accountDiscriminator(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", enc(`account:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

/** Retry on public-RPC 429s. Sequential leaf rebuild needs this or the first page dies. */
async function rpcRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let delay = 500;
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/429|Too Many|rate.?limit/i.test(msg) || attempt === 7) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
  throw last instanceof Error ? last : new Error(`${label}: ${String(last)}`);
}

function parseLeafEventsFromLogs(
  logs: string[] | null | undefined,
  depositDisc: Uint8Array,
  changeDisc: Uint8Array,
  into: Map<number, bigint>,
): void {
  for (const line of logs ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = Uint8Array.from(atob(line.slice("Program data: ".length)), (c) => c.charCodeAt(0));
    if (raw.length < 8) continue;
    const body = raw.subarray(8);
    if (depositDisc.every((b, k) => raw[k] === b) && body.length >= DEPOSIT_EVENT_FIELDS) {
      const commitment = body.subarray(64, 96);
      const idx = Number(new DataView(body.buffer, body.byteOffset + 96, 8).getBigUint64(0, true));
      into.set(idx, leToField(commitment));
      continue;
    }
    if (changeDisc.every((b, k) => raw[k] === b) && body.length >= LEAF_INSERTED_FIELDS) {
      const commitment = body.subarray(0, 32);
      const idx = Number(new DataView(body.buffer, body.byteOffset + 32, 8).getBigUint64(0, true));
      into.set(idx, leToField(commitment));
    }
  }
}

/**
 * Ordered leaf list rebuilt from on-chain `LeafIndexAccount` PDAs + their create-tx events.
 *
 * Prefer {@link fetchZkStateLeavesFromIndexer} (ASP DB / shared server cache). This path exists
 * when the indexer is gappy: instead of walking every vault signature (189+ getTransaction →
 * public RPC 429), it lists the ~N leaf PDAs (one getProgramAccounts) and fetches each PDA's
 * create transaction (2N calls) — enough to finish under rate limits.
 */
export async function fetchZkStateLeaves(
  connection: Connection = getDevnetConnection(),
  programId: PublicKey = getZkProgramId(),
  prefetchedHead?: { nextIndex: bigint; root: Uint8Array },
): Promise<bigint[]> {
  const depositDisc = await eventDiscriminator("DepositEvent");
  const changeDisc = await eventDiscriminator("LeafInserted");
  const leafDisc = await accountDiscriminator("LeafIndexAccount");
  const head = prefetchedHead ?? (await fetchZkTreeHead(connection, programId));
  const fresh = cachedSolanaLeavesIfFresh(head);
  if (fresh) return fresh;

  const nextIndex = Number(head.nextIndex);
  // Anchor LeafIndexAccount: 8-byte disc + bump u8 + leaf_index u64.
  const LEAF_ACCOUNT_SIZE = 8 + 1 + 8;
  const accounts = await rpcRetry(
    () =>
      connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [{ dataSize: LEAF_ACCOUNT_SIZE }],
      }),
    "getProgramAccounts(LeafIndexAccount)",
  );

  const found = new Map<number, bigint>();
  for (const { pubkey, account } of accounts) {
    const data =
      account.data instanceof Uint8Array
        ? account.data
        : new Uint8Array(account.data as ArrayLike<number>);
    if (data.length < LEAF_ACCOUNT_SIZE) continue;
    if (!leafDisc.every((b, i) => data[i] === b)) continue;
    const leafIndex = Number(new DataView(data.buffer, data.byteOffset + 9, 8).getBigUint64(0, true));
    if (leafIndex < 0 || leafIndex >= nextIndex) continue;

    await new Promise((r) => setTimeout(r, 300));
    const sigs = await rpcRetry(
      () => connection.getSignaturesForAddress(pubkey, { limit: 5 }, "confirmed"),
      `getSignatures(${pubkey.toBase58()})`,
    );
    if (sigs.length === 0) continue;
    // Newest-first; the create ix is the oldest signature that still touches this PDA.
    const createSig = sigs[sigs.length - 1]!.signature;
    await new Promise((r) => setTimeout(r, 300));
    const tx = await rpcRetry(
      () =>
        connection.getTransaction(createSig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }),
      `getTransaction(${createSig.slice(0, 8)})`,
    );
    parseLeafEventsFromLogs(tx?.meta?.logMessages, depositDisc, changeDisc, found);
  }

  const leaves: bigint[] = [];
  for (let i = 0; i < nextIndex; i++) {
    const leaf = found.get(i);
    if (leaf === undefined) {
      throw new Error(
        `Solana ZK state leaves incomplete: leaf ${i} missing after LeafIndexAccount scan ` +
          `(have ${found.size}/${nextIndex}). Redeploy solasp with auto-backfill, or retry.`,
      );
    }
    leaves.push(leaf);
  }
  const root = await computeStateRoot(leaves);
  if (root !== leToField(head.root)) {
    throw new Error("Solana ZK state leaves do not reproduce the on-chain root — refusing to prove.");
  }
  return cacheSolanaLeaves(head, leaves);
}

// ───────────────────────────────────────────────────────────────────────────── withdraw

export type ZkWithdrawResult = {
  commitSignature: string;
  spendSignature: string;
  circuit: string;
  amount: string;
  /** Change note (if any) already persisted to the note store. */
  changeCommitmentHex?: string;
};

function notesToPlanner(notes: SolanaStoredNote[]): PlannerNote[] {
  return notes.map((n) => ({
    commitment: n.commitment,
    value: BigInt(n.value),
    label: n.label,
    assetId: n.assetId,
    nullifier: n.nullifier,
    secret: n.secret,
  }));
}

export type SolanaZkSpendProof = {
  owner: string;
  programId: PublicKey;
  mint: PublicKey;
  recipient: string;
  circuit: string;
  circuitIndex: number;
  binder: Uint8Array;
  proof: Uint8Array;
  publics: string[];
  nullifiers: Uint8Array[];
  stateRoot: string;
  amountBaseUnits: string;
  inputCommitmentHexes: string[];
  /** Present when the spend leaves a change note. No depositSig until the spend lands. */
  changeNote?: SolanaStoredNote;
};

/**
 * Plan, witness, and prove a ZK withdraw to `recipient` without submitting.
 * Note secrets stay in the browser. The caller submits `commit_public_inputs` + `spend`,
 * or hands this package to the executor (Meteora settlement).
 */
export async function proveSolanaZkSpend(params: {
  owner: string;
  mint?: PublicKey;
  amountBaseUnits: bigint;
  recipient: string;
  fetchLeaves?: () => Promise<bigint[]>;
  onStatus?: (message: string) => void;
  /** Spend exactly these notes (an armed order re-proving its own reserved inputs). */
  notes?: SolanaStoredNote[];
}): Promise<SolanaZkSpendProof> {
  const say = params.onStatus ?? (() => undefined);
  const programId = getZkProgramId();
  const connection = getDevnetConnection();
  const owner = params.owner;
  const recipient = new PublicKey(params.recipient);

  const vault = await fetchZkVaultState(connection, programId);
  const mint = params.mint ?? vault.allowedMint;
  if (
    !mint.equals(vault.allowedMint) &&
    !mint.equals(NATIVE_MINT) &&
    !mint.equals(DEVNET_JL_USDC_MINT)
  ) {
    throw new Error(
      `This ZK vault holds ${vault.allowedMint.toBase58()}, WSOL, or jlUSDC; not ${mint.toBase58()}.`,
    );
  }
  const expectedVersion = fieldToLe32(BigInt(PROGRAM_VERSION_V3));
  if (!vault.programVersion.every((b, i) => b === expectedVersion[i])) {
    throw new Error(`ZK vault program_version != ${PROGRAM_VERSION_V3}; client and vault are out of sync.`);
  }

  const mintStr = mint.toBase58();
  const assetId = assetIdFromSolanaMint(mint.toBytes()).toString();
  const sym = solanaSymbolForMint(mintStr);
  // Coin-select by assetId (circuit bind), not mint base58 alone. Two pubkeys can collide after
  // field reduction; a note filed under a twin mint with the same assetId is still the right leaf.
  const pool = params.notes ?? (await loadSolanaNotes(owner)).filter(isSpendableSolanaNote);
  let notes = pool.filter((n) => String(n.assetId) === assetId && BigInt(n.value) > 0n);
  const mintMatched = notes.filter((n) => n.mint === mintStr);
  if (mintMatched.length > 0) notes = mintMatched;

  if (notes.length === 0) {
    const loaded = params.notes ? pool : await loadSolanaNotes(owner);
    const pending = loaded.filter(
      (n) => !n.spent && !n.depositSig && (n.mint === mintStr || String(n.assetId) === assetId),
    );
    if (pending.length > 0) {
      throw new Error(
        `Solana ${sym} notes are still pending deposit confirmation (${pending.length}) — wait for the deposit to land, then retry.`,
      );
    }
    const byMint = pool.filter((n) => n.mint === mintStr && BigInt(n.value) > 0n);
    if (byMint.length > 0) {
      throw new Error(
        `Found ${byMint.length} ${sym} note(s) under mint ${mintStr}, but their assetId (${byMint[0].assetId}) does not match ${assetId}.`,
      );
    }
    const spent = loaded.filter(
      (n) => n.spent && (n.mint === mintStr || String(n.assetId) === assetId),
    );
    if (spent.length > 0) {
      throw new Error(
        `No spendable ${sym} notes — ${spent.length} matching note(s) are already marked spent (prior withdraw or armed order).`,
      );
    }
    throw new Error(`No spendable ${sym} notes in the local store for mint ${mintStr}.`);
  }

  say("Reading Solana ZK state tree…");
  const leaves = await (params.fetchLeaves ?? fetchZkStateLeavesFromIndexer)();
  const stateRoot = await computeStateRoot(leaves);
  const head = await fetchZkTreeHead(connection, programId);
  if (stateRoot !== leToField(head.root)) {
    throw new Error("Solana ZK state leaves are stale (root != on-chain root) — resync and retry.");
  }

  // Drop commitments that are not in the live tree (prior vault / rewritten orphans).
  const inTree = filterNotesInLeaves(notes, leaves);
  if (inTree.length < notes.length && !params.notes) {
    deleteSolanaNotesNotInLeaves(notes, leaves);
  }
  notes = inTree;
  if (notes.length === 0) {
    throw new Error(
      `No ${sym} notes in the live vault tree — deposit again on this vault (prior-program notes cannot be withdrawn here).`,
    );
  }

  const plan = planWithdraw(notesToPlanner(notes), params.amountBaseUnits, assetId);
  const circuit = `withdraw${plan.inputCount}`;

  say("Checking ASP admission…");
  await ensureSolanaNotesAdmitted(owner, notes, say);

  say("Building witness…");
  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();
  const built = await buildWithdrawWitness({
    plan,
    leaves,
    outNullifier,
    outSecret,
    // The deployed program binds the payee as spend_payee_id_compat: PayeeId over the FIRST 20
    // bytes of the pubkey (the EVM-width rawPayee the circuit accepts), then checks the payee ATA
    // owner against the full 32 bytes. So the witness uses the EVM path with that 20-byte prefix.
    rawPayee: `0x${bytesToHex(recipient.toBytes().subarray(0, 20))}`,
    chainId: SOLANA_DEVNET_CHAIN_ID,
    stateRoot,
    aspUrl: "",
    screenToken: "",
  });

  const roots = await fetchZkComplianceRoots(connection, programId);
  if (
    BigInt(built.roots.admittedRoot) !== leToField(roots.admittedRoot) ||
    BigInt(built.roots.revokedRoot) !== leToField(roots.revokedRoot)
  ) {
    throw new Error("ASP roots differ from the vault's on-chain compliance roots — authority must republish.");
  }

  say("Generating proof…");
  // Per-chain key set, like the EVM lanes: the devnet vault's VK PDAs hold the dev-beacon delta.
  // Lazy snarkjs: a static import breaks `/api/solana/leaves` when snarkjs is missing from the
  // standalone server image (leaves only need Poseidon / circomlibjs).
  const snarkjs = await import("snarkjs");
  const keys = zkProvingBase(SOLANA_DEVNET_CHAIN_ID);
  const { proof, publicSignals } = await proveSpend(
    { circuit, input: built.input as unknown as Record<string, unknown> },
    async () => {
      const { loadZkey } = await import("@/lib/v3/zkeyCache");
      return snarkjs.groth16.fullProve(
        built.input as unknown as Record<string, unknown>,
        zkUrl(`/zk/${circuit}/main_${circuit}.wasm`),
        await loadZkey(`${keys}/${circuit}/zkey_final.zkey`),
      );
    },
  );
  const got = publicSignals as string[];
  if (got.length !== built.expectedPublics.length) throw new Error("publics length mismatch");
  for (let i = 0; i < got.length; i++) {
    if (BigInt(got[i]) !== BigInt(built.expectedPublics[i])) {
      throw new Error(`publics limb[${i}] mismatch vs recomputed value`);
    }
  }
  const vKey = await fetch(`${keys}/${circuit}/verification_key.json`).then((r) => {
    if (!r.ok) throw new Error(`vkey HTTP ${r.status}`);
    return r.json();
  });
  if (!(await snarkjs.groth16.verify(vKey, got, proof))) {
    throw new Error("Local Groth16 verify failed — not submitting.");
  }
  const packed = packProofFromSnarkjs(proof as unknown as SnarkjsProof);
  const slot = circuitSlot(circuit);
  const vkAccount = vault.vkAccounts[slot];
  if (vkAccount.equals(PublicKey.default)) throw new Error(`VK for ${circuit} is not registered on the vault.`);

  const nullifiers = got
    .slice(NULLIFIER_START, NULLIFIER_START + plan.inputCount)
    .map((x) => fieldToLe32(BigInt(x)));

  let changeNote: SolanaStoredNote | undefined;
  const changeLimb = BigInt(got[7]);
  if (changeLimb !== 0n) {
    const boundaryLabel = plan.selected[plan.boundaryIndex].label;
    const precommitment = await hashPrecommitment(outNullifier, outSecret);
    changeNote = {
      nullifier: outNullifier.toString(),
      secret: outSecret.toString(),
      label: boundaryLabel,
      assetId,
      mint: mint.toBase58(),
      symbol: solanaSymbolForMint(mint.toBase58()),
      commitment: changeLimb.toString(),
      commitmentHex: bytesToHex(fieldToLe32(changeLimb)),
      value: plan.secondaryValue.toString(),
      precommitment: precommitment.toString(),
      userSalt: "0",
      spent: false,
    };
  }

  return {
    owner,
    programId,
    mint,
    recipient: recipient.toBase58(),
    circuit,
    circuitIndex: slot,
    binder: randomBytes(32),
    proof: packed,
    publics: got,
    nullifiers,
    stateRoot: stateRoot.toString(),
    amountBaseUnits: plan.primaryValue.toString(),
    inputCommitmentHexes: plan.selected.map((n) => {
      const hit = notes.find((x) => x.commitment === n.commitment);
      if (!hit) throw new Error("selected note missing from the local store");
      return hit.commitmentHex;
    }),
    changeNote,
  };
}

/**
 * Server-side prove for pipeline hop N≥1: spends a known returned note (secrets from the sealed
 * bundle) without a Phantom session. ASP paths come from the screen-token server client.
 */
export async function proveSolanaPipelineHop(params: {
  note: SolanaStoredNote;
  amountBaseUnits: bigint;
  recipient: string;
  onStatus?: (message: string) => void;
}): Promise<SolanaZkSpendProof> {
  const say = params.onStatus ?? (() => undefined);
  const programId = getZkProgramId();
  const connection = getDevnetConnection();
  const recipient = new PublicKey(params.recipient);
  const mint = new PublicKey(params.note.mint);
  const notes = [params.note];
  const assetId = String(params.note.assetId);

  say("Reading Solana ZK state tree…");
  const leaves = await fetchZkStateLeavesFromIndexer();
  const stateRoot = await computeStateRoot(leaves);
  const head = await fetchZkTreeHead(connection, programId);
  if (stateRoot !== leToField(head.root)) {
    throw new Error("Solana ZK state leaves are stale (root != on-chain root) — resync and retry.");
  }
  if (filterNotesInLeaves(notes, leaves).length === 0) {
    throw new Error("pipeline return note is not in the live vault tree yet");
  }

  const plan = planWithdraw(notesToPlanner(notes), params.amountBaseUnits, assetId);
  const circuit = `withdraw${plan.inputCount}`;

  say("Loading ASP paths (server)…");
  const { loadComplianceWitnessMultiServer } = await import("@/lib/v3/aspServerClient");
  const compliance = await loadComplianceWitnessMultiServer(
    plan.selected.map((n) => String(n.label)),
    SOLANA_DEVNET_CHAIN_ID,
  );

  say("Building witness…");
  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();
  const built = await buildWithdrawWitness({
    plan,
    leaves,
    outNullifier,
    outSecret,
    rawPayee: `0x${bytesToHex(recipient.toBytes().subarray(0, 20))}`,
    chainId: SOLANA_DEVNET_CHAIN_ID,
    stateRoot,
    aspUrl: "",
    screenToken: "",
    compliance,
  });

  const vault = await fetchZkVaultState(connection, programId);
  const roots = await fetchZkComplianceRoots(connection, programId);
  if (
    BigInt(built.roots.admittedRoot) !== leToField(roots.admittedRoot) ||
    BigInt(built.roots.revokedRoot) !== leToField(roots.revokedRoot)
  ) {
    throw new Error("ASP roots differ from the vault's on-chain compliance roots — authority must republish.");
  }

  say("Generating proof…");
  const snarkjs = await import("snarkjs");
  const keys = zkProvingBase(SOLANA_DEVNET_CHAIN_ID);
  const { proof, publicSignals } = await proveSpend(
    { circuit, input: built.input as unknown as Record<string, unknown> },
    async () => {
      // Node snarkjs uses fs.open on string paths — materialise S3 wasm/zkey as bytes.
      const { loadZkey } = await import("@/lib/v3/zkeyCache");
      const wasm = await loadZkey(zkUrl(`/zk/${circuit}/main_${circuit}.wasm`));
      const zkey = await loadZkey(`${keys}/${circuit}/zkey_final.zkey`);
      return snarkjs.groth16.fullProve(
        built.input as unknown as Record<string, unknown>,
        wasm,
        zkey,
      );
    },
  );
  const got = publicSignals as string[];
  if (got.length !== built.expectedPublics.length) throw new Error("publics length mismatch");
  for (let i = 0; i < got.length; i++) {
    if (BigInt(got[i]) !== BigInt(built.expectedPublics[i])) {
      throw new Error(`publics limb[${i}] mismatch vs recomputed value`);
    }
  }
  const packed = packProofFromSnarkjs(proof as unknown as SnarkjsProof);
  const slot = circuitSlot(circuit);
  const vkAccount = vault.vkAccounts[slot];
  if (vkAccount.equals(PublicKey.default)) throw new Error(`VK for ${circuit} is not registered on the vault.`);
  const nullifiers = got
    .slice(NULLIFIER_START, NULLIFIER_START + plan.inputCount)
    .map((x) => fieldToLe32(BigInt(x)));

  return {
    owner: params.recipient,
    programId,
    mint,
    recipient: recipient.toBase58(),
    circuit,
    circuitIndex: slot,
    binder: randomBytes(32),
    proof: packed,
    publics: got,
    nullifiers,
    stateRoot: stateRoot.toString(),
    amountBaseUnits: plan.primaryValue.toString(),
    inputCommitmentHexes: [params.note.commitmentHex],
  };
}

/**
 * Withdraw from the ZK vault to `recipient` (a Solana pubkey):
 *   plan → witness → proveRemote.proveSpend (enclave, browser fallback) → local verify →
 *   executor relay (commit_public_inputs + spend from its wallet; no wallet popup, no fee) →
 *   mark inputs spent / store the change note.
 */
export async function withdrawZkSolana(params: {
  phantom: PhantomLike;
  /** SPL mint of the notes to spend; defaults to the vault's allowed mint. */
  mint?: PublicKey;
  amountBaseUnits: bigint;
  /** Recipient Solana pubkey (base58). */
  recipient: string;
  /** Replace the DepositEvent scan with an indexer. */
  fetchLeaves?: () => Promise<bigint[]>;
  onStatus?: (message: string) => void;
}): Promise<ZkWithdrawResult> {
  const say = params.onStatus ?? (() => undefined);
  const owner = new PublicKey(params.phantom.publicKey.toBytes()).toBase58();
  const proved = await proveSolanaZkSpend({
    owner,
    mint: params.mint,
    amountBaseUnits: params.amountBaseUnits,
    recipient: params.recipient,
    fetchLeaves: params.fetchLeaves,
    onStatus: params.onStatus,
  });
  // The executor relays it (commit + spend from its own wallet, fees on it): the user signs
  // nothing. The proof binds the payee, so the relayer can only pay `recipient`.
  say("Submitting withdrawal…");
  const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
  // Same-origin. The executor's CORS preflight does not allow the Phantom session headers.
  const res = await fetch("/api/solana/relay-withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) },
    body: JSON.stringify({
      user_id: owner,
      recipient: proved.recipient,
      package: {
        publics: proved.publics,
        proof_hex: bytesToHex(proved.proof),
        binder_hex: bytesToHex(proved.binder),
        nullifiers_hex: proved.nullifiers.map(bytesToHex),
        circuit_index: proved.circuitIndex,
        mint: proved.mint.toBase58(),
      },
    }),
  });
  const relayed = (await res.json().catch(() => ({}))) as { ok?: boolean; commit_sig?: string; spend_sig?: string; error?: string };
  if (!res.ok || !relayed.ok || !relayed.spend_sig) {
    throw new Error(relayed.error || `withdraw relay failed (HTTP ${res.status})`);
  }
  const commitSignature = relayed.commit_sig ?? "";
  const spendSignature = relayed.spend_sig;

  for (const hex of proved.inputCommitmentHexes) {
    await markSolanaNoteSpent(owner, hex);
  }
  if (proved.changeNote) {
    await saveSolanaNote(owner, { ...proved.changeNote, depositSig: spendSignature });
  }
  // Spend inserts a change leaf (and always advances the tree) — drop the root-keyed cache.
  invalidateSolanaStateLeavesCache();

  return {
    commitSignature,
    spendSignature,
    circuit: proved.circuit,
    amount: proved.amountBaseUnits,
    changeCommitmentHex: proved.changeNote?.commitmentHex,
  };
}

// ───────────────────────────────────────────────────────────────────────────── split

export type SolanaZkSplitResult = {
  signature: string;
  /** The new notes, in slot order, already saved as spendable. */
  slices: SolanaStoredNote[];
  /** The tree's leaves after the split (its root matches the chain), for proving the slices. */
  leaves: bigint[];
};

/**
 * Split one note into `values.length` (≤ 8) notes under its label, in one Phantom-signed
 * commit + spend_split. Σ values must equal the note's value — the circuit spends the whole note.
 */
export async function splitZkSolana(params: {
  phantom: PhantomLike;
  note: SolanaStoredNote;
  values: bigint[];
  onStatus?: (message: string) => void;
}): Promise<SolanaZkSplitResult> {
  const say = params.onStatus ?? (() => undefined);
  const { note, values } = params;
  if (values.length < 2 || values.length > MAX_SPLIT_OUTPUTS) throw new Error("split into 2 to 8 notes");
  if (values.some((v) => v <= 0n) || values.reduce((a, b) => a + b, 0n) !== BigInt(note.value)) {
    throw new Error("split values must be positive and add up to the note");
  }
  const connection = getDevnetConnection();
  const programId = getZkProgramId();
  const spender = new PublicKey(params.phantom.publicKey.toBytes());
  const owner = spender.toBase58();

  say("Reading Solana ZK state tree…");
  const leaves = await fetchZkStateLeavesFromIndexer();
  const stateRoot = await computeStateRoot(leaves);
  if (stateRoot !== leToField((await fetchZkTreeHead(connection, programId)).root)) {
    throw new Error("Solana ZK state leaves are stale (root != on-chain root) — resync and retry.");
  }
  if (filterNotesInLeaves([note], leaves).length === 0) {
    deleteSolanaNotesNotInLeaves([note], leaves);
    throw new Error(
      "That note is not in the live vault tree — deposit again on this vault (prior-program notes cannot be split here).",
    );
  }
  const idx = findLeafIndex(leaves, BigInt(note.commitment));
  if (idx < 0) throw new Error("This note is not in the vault tree yet — wait for the deposit to index.");
  const path = await buildStatePath(leaves, idx, TREE_DEPTH);
  const compliance = await loadComplianceWitnessMulti("", "", [note.label], { chainId: SOLANA_DEVNET_CHAIN_ID });
  const roots = await fetchZkComplianceRoots(connection, programId);
  if (
    BigInt(compliance.admittedRoot) !== leToField(roots.admittedRoot) ||
    BigInt(compliance.revokedRoot) !== leToField(roots.revokedRoot)
  ) {
    throw new Error("ASP roots differ from the vault's on-chain compliance roots — authority must republish.");
  }

  say("Building split witness…");
  const slices: SplitSlice[] = Array.from({ length: MAX_SPLIT_OUTPUTS }, (_, i) =>
    i < values.length
      ? { value: values[i], nullifier: randomUserSalt(), secret: randomUserSalt() }
      : { value: 0n, nullifier: 0n, secret: 0n },
  );
  const labelCommitSalt = randomLabelSalt();
  const { publics, splitCommitments } = await deriveSplitPublics({
    input: {
      inValue: BigInt(note.value),
      inNullifier: BigInt(note.nullifier),
      inSecret: BigInt(note.secret),
      inLabel: BigInt(note.label),
      inAssetId: BigInt(note.assetId),
    },
    slices,
    roots: { stateRoot, admittedRoot: BigInt(compliance.admittedRoot), revokedRoot: BigInt(compliance.revokedRoot) },
    labelCommitSalt,
  });
  const input = splitWitnessInput(
    { commitment: note.commitment, value: BigInt(note.value), label: note.label, assetId: note.assetId, nullifier: note.nullifier, secret: note.secret },
    slices,
    { statePathElements: [path.pathElements.map(String)], statePathIndices: [path.pathIndices], compliance, stateRoot },
    publics,
    labelCommitSalt,
  );

  say("Generating split proof…");
  const snarkjs = await import("snarkjs");
  const keys = zkProvingBase(SOLANA_DEVNET_CHAIN_ID);
  const { proof, publicSignals } = await proveSpend({ circuit: "split", input }, async () =>
    snarkjs.groth16.fullProve(
      input,
      zkUrl("/zk/split/main_split.wasm"),
      await (await import("@/lib/v3/zkeyCache")).loadZkey(`${keys}/split/zkey_final.zkey`),
    ),
  );
  const got = publicSignals as string[];
  if (got.length !== publics.length || got.some((x, i) => BigInt(x) !== BigInt(publics[i]))) {
    throw new Error("split publics mismatch vs recomputed value");
  }
  const vKey = await fetch(`${keys}/split/verification_key.json`).then((r) => r.json());
  if (!(await snarkjs.groth16.verify(vKey, got, proof))) throw new Error("Local Groth16 verify failed — not submitting.");

  // Relayed like a withdraw: the executor commits + submits spend_split from its own wallet, so
  // the user signs nothing. The program re-hashes these 8 commitments to the proof's root.
  const commitments = splitCommitments.map((c) => fieldToLe32(BigInt(c)));
  say("Splitting the note…");
  const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
  const res = await fetch("/api/solana/relay-withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) },
    body: JSON.stringify({
      user_id: owner,
      package: {
        publics: got,
        proof_hex: bytesToHex(packProofFromSnarkjs(proof as unknown as SnarkjsProof)),
        binder_hex: bytesToHex(randomBytes(32)),
        nullifiers_hex: [bytesToHex(fieldToLe32(BigInt(got[NULLIFIER_START])))],
        circuit_index: circuitSlot("split"),
        split_commitments_hex: commitments.map(bytesToHex),
      },
    }),
  });
  const relayed = (await res.json().catch(() => ({}))) as { ok?: boolean; spend_sig?: string; error?: string };
  if (!res.ok || !relayed.ok || !relayed.spend_sig) {
    throw new Error(relayed.error || `split relay failed (HTTP ${res.status})`);
  }
  const signature = relayed.spend_sig;

  await markSolanaNoteSpent(owner, note.commitmentHex);
  const out: SolanaStoredNote[] = [];
  for (let i = 0; i < values.length; i++) {
    const s = slices[i];
    const c = BigInt(splitCommitments[i]);
    const n: SolanaStoredNote = {
      nullifier: s.nullifier.toString(),
      secret: s.secret.toString(),
      label: note.label,
      assetId: note.assetId,
      mint: note.mint,
      symbol: note.symbol,
      commitment: c.toString(),
      commitmentHex: bytesToHex(fieldToLe32(c)),
      value: s.value.toString(),
      precommitment: (await hashPrecommitment(s.nullifier, s.secret)).toString(),
      userSalt: "0",
      depositSig: signature,
      spent: false,
    };
    await saveSolanaNote(owner, n);
    out.push(n);
  }

  // The slices are contiguous leaves; anything else that landed meanwhile shows up in the indexer.
  invalidateSolanaStateLeavesCache();
  let after = [...leaves, ...out.map((n) => BigInt(n.commitment))];
  for (let i = 0; i < 60; i++) {
    const headRaw = await fetchZkTreeHead(connection, programId);
    const head = leToField(headRaw.root);
    if ((await computeStateRoot(after)) === head) {
      cacheSolanaLeaves(headRaw, after);
      return { signature, slices: out, leaves: after };
    }
    await new Promise((r) => setTimeout(r, 3000));
    after = await fetchZkStateLeavesFromIndexer().catch(() => after);
  }
  throw new Error("The split landed but the vault tree has not caught up — retry in a minute.");
}


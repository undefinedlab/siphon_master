/**
 * v3 note hashing — PROTOCOL 3.5 (D1, asset-bound notes).
 *
 * Normative source: `siphon-zk-v2/spend-core/src/{commitment,deposit,chain_profile}.rs`.
 * Verified against the shared fixtures in `siphon-zk-v2/test-vectors/` (see noteCryptoV3.test.ts) —
 * those fixtures are the executable contract between this file, spend-core, and the circuits.
 *
 *   precommitment = Poseidon(nullifier, secret)
 *   inner         = Poseidon(amount, label, assetId)      // 3-input, NOT nested 2-input
 *   commitment    = Poseidon(inner, precommitment)
 *   nullifierHash = Poseidon(nullifier)
 *
 *   vaultScopeId  = Poseidon(DOMAIN_CHAIN_EVM, chainId, uint160(vault))
 *   nonceStem     = Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce)
 *   label         = Poseidon(nonceStem, userSalt)         // userSalt != 0, never on-chain
 *
 * WHAT CHANGED FROM v2 (`noteCrypto.ts`) — do not mix the two:
 *   - v2 inner was Poseidon(amount, label); v3 folds in `assetId` as a THIRD input. A 3-input
 *     Poseidon is a different permutation instance (T4 vs T3), so this is not expressible as
 *     nested 2-input hashes. Using the v2 form on a v3 vault yields a commitment that is never
 *     in the tree — funds appear to vanish.
 *   - v2 label was Poseidon(scope, nonce) with scope = uint160(vault). v3 salts it and derives
 *     scope through a domain-separated hash. PROTOCOL §2.3 forbids the unsalted form: the deposit
 *     nonce is a public counter, so unsalted labels are enumerable.
 *
 * NOTE ON spend-core: `chain_profile::mint_label` is the UNSALTED stem and MUST NOT be used as a
 * label on its own (it is an intermediate). The salted mint lives in `deposit::mint_label_salted`.
 */
// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();
import { NATIVE_TOKEN, getNetwork } from "../networks";

/** BN254 scalar field. */
export const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Domain separators — `siphon-zk-v2/test-vectors/domains.json`.
 * These are consensus constants: changing one invalidates every existing note.
 */
export const DOMAIN_VAULT_SCOPE = 3n;
export const DOMAIN_CHAIN_EVM = 5n;
/** solana-v1 chain profile (`siphon-zk-v2/test-vectors/domains.json`). */
export const DOMAIN_CHAIN_SOL = 6n;
/** Solana payee compression: payeeField = Poseidon(DOMAIN_PAYEE_SOL_COMPRESS, BE(pubkey)). */
export const DOMAIN_PAYEE_SOL_COMPRESS = 7n;

export function modField(x: bigint): bigint {
  const r = x % FIELD;
  return r < 0n ? r + FIELD : r;
}

/**
 * 32 bytes as a big-endian integer, reduced mod FIELD.
 * Mirrors `siphon-vault-zk::poseidon::field_from_be_bytes` (used for program id, vault PDA,
 * mint pubkey and raw payee pubkey).
 */
export function fieldFromBe32(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error(`fieldFromBe32: expected 32 bytes, got ${bytes.length}`);
  }
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return modField(v);
}

type PoseidonFn = {
  (inputs: bigint[]): unknown;
  F: { toObject: (x: unknown) => bigint | string };
};

let _poseidon: PoseidonFn | null = null;

export async function getPoseidon(): Promise<PoseidonFn> {
  if (_poseidon) return _poseidon;
  _poseidon = (await buildPoseidon()) as PoseidonFn;
  return _poseidon;
}

async function poseidonN(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  return BigInt(p.F.toObject(p(inputs.map(modField))));
}

export async function poseidon1(a: bigint): Promise<bigint> {
  return poseidonN([a]);
}

export async function poseidon2(a: bigint, b: bigint): Promise<bigint> {
  return poseidonN([a, b]);
}

/** 3-input Poseidon (T4). Required for the D1 commitment inner hash and the label stem. */
export async function poseidon3(a: bigint, b: bigint, c: bigint): Promise<bigint> {
  return poseidonN([a, b, c]);
}

// ---------------------------------------------------------------- note hashing

export async function hashPrecommitment(nullifier: bigint, secret: bigint): Promise<bigint> {
  return poseidon2(nullifier, secret);
}

export async function hashNullifier(nullifier: bigint): Promise<bigint> {
  return poseidon1(nullifier);
}

/**
 * D1 note commitment. `assetId` is uint160(token) — see {@link assetIdFromToken}.
 * Mirrors `spend-core::commitment::commitment_with_pre`.
 */
export async function hashCommitmentWithPre(
  amount: bigint,
  label: bigint,
  assetId: bigint,
  precommitment: bigint,
): Promise<bigint> {
  const inner = await poseidon3(amount, label, assetId);
  return poseidon2(inner, precommitment);
}

/** D1 note commitment from note secrets. Mirrors `spend-core::commitment::commitment`. */
export async function hashCommitment(
  amount: bigint,
  label: bigint,
  assetId: bigint,
  nullifier: bigint,
  secret: bigint,
): Promise<bigint> {
  const pre = await hashPrecommitment(nullifier, secret);
  return hashCommitmentWithPre(amount, label, assetId, pre);
}

// ---------------------------------------------------------------- label mint

/**
 * The ERC-20 a note actually binds for a token the UI displays.
 *
 * Native ETH is not a D1 note asset: `assetId = uint160(token)` and withdraw casts it back with
 * `tokenFromAssetId`, so the note must name a real ERC-20. Deposits wrap ETH to WETH, which means
 * every consumer that derives an assetId from a *displayed* token has to perform the same
 * substitution — otherwise a wrapped deposit lands under WETH's assetId while the balance card
 * looks for the 0xEeee… sentinel's, and the note is invisible despite being on-chain.
 */
export function noteAssetAddress(chainId: number, tokenAddress: string): string {
  const raw = (tokenAddress || "").trim().toLowerCase();
  const isNative =
    !raw ||
    raw === "0x0000000000000000000000000000000000000000" ||
    raw === NATIVE_TOKEN.toLowerCase();
  if (!isNative) return tokenAddress;

  const weth = getNetwork(chainId).weth;
  if (!weth) {
    throw new Error(`noteAssetAddress: no WETH configured for chain ${chainId}`);
  }
  return weth;
}

/**
 * The assetId a note actually carries for a token the UI displays.
 *
 * ALWAYS use this at display-facing call sites instead of assetIdFromToken(displayedToken).
 * Native ETH wraps to WETH on deposit, so a note minted from "ETH" binds uint160(WETH) — deriving
 * straight from the 0xEeee… sentinel yields an assetId no note has ever had. That mismatch is
 * silent: balances read zero, and coin selection reports "no spendable notes" for funds that are
 * demonstrably in the pool.
 */
export function noteAssetIdFor(chainId: number, tokenAddress: string): bigint {
  return assetIdFromToken(noteAssetAddress(chainId, tokenAddress));
}

/** `assetId = uint160(token)`. Native ETH is not a D1 note asset — use WETH (PROTOCOL §2.2). */
export function assetIdFromToken(tokenAddress: string): bigint {
  const raw = (tokenAddress || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(raw)) {
    throw new Error(`assetIdFromToken: expected a 20-byte 0x address, got "${tokenAddress}"`);
  }
  return BigInt(raw);
}

/** `vaultScopeId = Poseidon(DOMAIN_CHAIN_EVM, chainId, uint160(vault))` — evm-v1 profile. */
export async function vaultScopeId(chainId: number | bigint, vaultAddress: string): Promise<bigint> {
  const addr = (vaultAddress || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`vaultScopeId: expected a 20-byte 0x address, got "${vaultAddress}"`);
  }
  return poseidon3(DOMAIN_CHAIN_EVM, BigInt(chainId), BigInt(addr));
}

/** `assetId` for a Solana SPL note = the mint pubkey as a BE field element (solana-v1 profile). */
export function assetIdFromSolanaMint(mintBytes32: Uint8Array): bigint {
  return fieldFromBe32(mintBytes32);
}

/**
 * `vaultScopeId = Poseidon(DOMAIN_CHAIN_SOL, BE(programId), BE(vaultPda))` — solana-v1 profile.
 * Mirrors `siphon-vault-zk::poseidon::vault_scope_id` and `chain-profile-solana.json`.
 */
export async function vaultScopeIdSolana(
  programIdBytes32: Uint8Array,
  vaultPdaBytes32: Uint8Array,
): Promise<bigint> {
  return poseidon3(
    DOMAIN_CHAIN_SOL,
    fieldFromBe32(programIdBytes32),
    fieldFromBe32(vaultPdaBytes32),
  );
}

/**
 * Salted deposit label — PROTOCOL §2.3.
 *
 * `userSalt` MUST be non-zero and MUST NEVER be sent on-chain or logged: it is the only thing
 * standing between a public deposit counter and an enumerable label set.
 */
export async function mintLabelSalted(
  scopeId: bigint,
  depositNonce: number | bigint,
  userSalt: bigint,
): Promise<bigint> {
  if (modField(userSalt) === 0n) {
    throw new Error("mintLabelSalted: userSalt must be non-zero (PROTOCOL §2.3 / O-24)");
  }
  const stem = await poseidon3(DOMAIN_VAULT_SCOPE, scopeId, BigInt(depositNonce));
  return poseidon2(stem, userSalt);
}

/** Convenience: derive the label straight from chain + vault + nonce + salt. */
export async function deriveDepositLabel(params: {
  chainId: number | bigint;
  vaultAddress: string;
  depositNonce: number | bigint;
  userSalt: bigint;
}): Promise<bigint> {
  const scope = await vaultScopeId(params.chainId, params.vaultAddress);
  return mintLabelSalted(scope, params.depositNonce, params.userSalt);
}

/**
 * Generate a non-zero `userSalt` from the CSPRNG.
 *
 * Rejection-samples into the field: taking `random % FIELD` would bias the low range, and while
 * that bias is not practically exploitable here, an unbiased salt costs one extra draw at most.
 */
export function randomUserSalt(): bigint {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i++) {
    crypto.getRandomValues(bytes);
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    if (v < FIELD && v !== 0n) return v;
  }
  throw new Error("randomUserSalt: exhausted rejection sampling");
}

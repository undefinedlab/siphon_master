import { ethers, Contract, Network } from 'ethers';
import crypto from 'crypto';
// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();
import { prepareWithdrawalTransactionMulti, prepareSwapTransaction, prepareSplitTransaction } from "./generateProof";
import { getProvider, getSigner } from './nexus';
import { getNetwork, getReadProviderRpcUrl, getSelectedChainId, getTokens } from './networks';
import { localNoteAmountToHuman } from './noteAmount';
import { v3Config as v3ConfigFor } from './v3/configV3';
import { rpcRetryPlan } from './rpcRetryPolicy';
import { vaultInflowCandidatesFromLogs } from './vaultInflow';
import { assetSymbolForToken, fetchIndexedDeposit, fetchIndexedLeaves, fetchIndexedLeavesPage } from './leafIndexClient';
import {
  MerkleTreeError,
  MerkleTreeView,
  assertUsableMerkleRoot,
  type Poseidon2,
} from './merkleTreeView';
import {
  clearMerkleLeafStore,
  loadLeafSnapshot,
  saveLeafSnapshot,
  syncMerkleLeaves,
  verifySyncedLeaves,
  MERKLE_LEAF_CACHE_VERSION,
} from './merkleLeafCache';
import {
  mergeLeafInsertedCatchup,
  planLeafLogScan,
  sleep,
  type LeafInsertedEvent,
} from './merkleLeafRpc';
import entrypointArtifact from './abi/Entrypoint.json';
import nativeVaultAbiJson from './abi/NativeVault.json';
import merkleTreeAbiJson from './abi/MerkleTree.json';
import { selectSmallestUnspent } from './spendableNoteSelection';

// --------- Constants ----------
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Per-chain read provider + deploy block come from the network registry so leaf scans always
// hit the SELECTED chain (Eth Sepolia / Base Sepolia) regardless of the wallet's current network.
const vaultDeployBlock = (chainId?: number): number => getNetwork(chainId).deployBlock;
// Initial getLogs window. Shrinks automatically when an RPC rejects the range (free tiers
// cap this — Alchemy FREE is only 10 blocks, others 50/2k/10k). Default 9000 fits the public
// Base node's 10k cap so the full ~27k-block leaf scan is ~3 calls, not ~14. The /api/rpc proxy
// fast-fails a free-tier Alchemy 400 (range too large) and falls through to the public node, so a
// large chunk is safe even when BASE_MAINNET_RPC points at a free Alchemy key. Too many small
// calls through the serverless proxy is what made the leaf scan hang / time out.
const GETLOGS_CHUNK = parseInt(process.env.NEXT_PUBLIC_GETLOGS_CHUNK || '9000', 10);

/** Retry a provider call with exponential backoff. Policy lives in rpcRetryPolicy (tested). */
async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  let delay = 300;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = JSON.stringify(err ?? '') + String((err as Error)?.message ?? '');
      const plan = rpcRetryPlan(msg, tries);
      if (!plan.retry || attempt >= plan.maxTries - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
    }
  }
}

/** Run async `fn` over `items` with bounded concurrency (avoids bursting the RPC). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Pull `[from, to]` for a suggested block range out of a provider error, if present. */
function suggestedRangeFromError(err: unknown): number | null {
  const m = JSON.stringify(err ?? '').match(/\[0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+)\]/);
  if (!m) return null;
  const span = parseInt(m[2], 16) - parseInt(m[1], 16) + 1;
  return span > 0 ? span : null;
}

/**
 * getLogs across a wide block range by walking it in chunks, shrinking the window when the
 * RPC rejects it (honouring the provider's suggested range when given). Works on free tiers
 * that cap eth_getLogs; just slower the smaller the cap.
 */
export async function getLogsChunked(
  provider: ethers.Provider,
  filter: { address: string; topics: (string | null)[] },
  fromBlock: number,
  toBlock: number,
): Promise<ethers.Log[]> {
  const out: ethers.Log[] = [];
  let chunk = Math.max(1, GETLOGS_CHUNK);
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const part = await withRetry(() =>
        provider.getLogs({ ...filter, fromBlock: start, toBlock: end }),
      );
      out.push(...part);
      start = end + 1;
    } catch (err) {
      const suggested = suggestedRangeFromError(err);
      if (suggested && suggested < chunk) { chunk = suggested; continue; }
      if (chunk > 1) { chunk = Math.max(1, Math.floor(chunk / 2)); continue; }
      throw err; // already at 1-block windows and still failing — genuine error
    }
  }
  return out;
}

// TEMPORARY diagnostic (remove once the arm stall is closed): stage timings for the pre-proof
// path. Every branch in generateSwapProof returns an error object, so a stall can only be a
// pending await — this prints which one we entered and never left.
const _armT = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
export function armTrace(stage: string, since?: number): number {
  const now = _armT();
  const delta = since != null ? ` +${Math.round(now - since)}ms` : "";
  console.log(`[ARM-TRACE] ${stage}${delta}`);
  return now;
}

// Reuse one read provider per chain — avoids ethers spawning retry loops per call.
const readProviderCache = new Map<number, ethers.Provider>();

export function getReadProvider(chainId?: number): ethers.Provider {
  const net = getNetwork(chainId ?? getSelectedChainId());
  const cached = readProviderCache.get(net.chainId);
  if (cached) return cached;

  const rpcUrl = getReadProviderRpcUrl(net.chainId);
  const network = Network.from(net.chainId);
  if (rpcUrl) {
    // batchMaxCount: 10 — ethers v6 auto-batches up to 100 JSON-RPC calls per HTTP
    // request, but the public Base RPC (and most free tiers) reject any batch >10 with
    // "-32014 maximum 10 calls in 1 batch", which failed the WHOLE balance reconcile →
    // "No funds detected". Cap at 10 so batching still cuts round-trips ~10x while
    // staying under the limit. A paid BASE_MAINNET_RPC allows far more but 10 is safe.
    // ethers' FetchRequest retries a 429 INTERNALLY (maxAttempts defaults to 12) before it ever
    // rejects. Measured against a node that always 429s: ONE eth_call became 8 HTTP requests in
    // 20s and was still going. Layered under withRetry's own retry, and pointed at our per-IP
    // limiter, that is a self-sustaining storm — each 429 provokes ~8 more requests, which keeps
    // the bucket full, which 429s the next call. Our proxy already retries the UPSTREAM 5x with
    // backoff, so a 429 reaching the browser is either our limiter or a genuinely exhausted
    // upstream; neither is helped by hammering. Fail the request once and let withRetry decide
    // (rpcRetryPolicy: our own limiter is not retried at all).
    const fetchReq = new ethers.FetchRequest(rpcUrl);
    fetchReq.retryFunc = async () => false;
    const provider = new ethers.JsonRpcProvider(fetchReq, network, {
      staticNetwork: network,
      batchMaxCount: 10,
    });
    readProviderCache.set(net.chainId, provider);
    return provider;
  }
  const walletProvider = getProvider();
  if (walletProvider) return walletProvider;
  throw new Error(`No RPC configured for chain ${net.chainId}.`);
}

/** Drop cached provider after a chain switch so reads target the new network. */
export function resetReadProvider(chainId?: number): void {
  if (chainId != null) readProviderCache.delete(chainId);
  else readProviderCache.clear();
}

// --------- Types ----------
export interface TokenInfo {
  symbol: string;
  decimals: number;
  address: string;
}

export interface CommitmentData {
  secret: string;
  nullifier: string;
  precommitment: string;
  commitment?: string;
  /** Hard ASP label (Poseidon(scope, nonce) or child label). */
  label?: string;
  amount: string;
  nullifierHash?: string;
}

export interface WithdrawalTxData {
  recipient: string;
  amount: string;
  /** Multi-note: all nullifier hashes that were spent. */
  nullifierHashes: string[];
  /** Alias kept for single-note callers. */
  nullifierHash?: string;
  /** Change note commitment inserted into the tree (0 when draining all input value). */
  changeCommitment: string;
  /** Hard ASP: association label bound into the change note / public signals. */
  changeLabel: string;
  /** Hard ASP: ASP Merkle root dual-inclusion public signal. */
  aspRoot: string;
  /** Alias kept for single-note callers. */
  newCommitment?: string;
  stateRoot: string;
  /**
   * Entrypoint.withdraw._changeValue — the change note's plaintext value (inSum − withdrawnValue).
   * It is a PRIVATE circuit input (only changeCommitment binds it) and is NOT in publicSignals, so
   * a relayer cannot recover it from the proof: every armed strategy must carry it or the executor
   * cannot build the call at all. Already public — it is a plain argument of the withdraw tx.
   */
  changeValue: string;
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  publicSignals?: string[];
  proof?: Record<string, unknown>;
}

export interface ZKData {
  withdrawalTxData: WithdrawalTxData;
  changeValue: bigint;
  newDepositKey: string;
  newDeposit: CommitmentData;
  /** All input notes consumed by this withdrawal. */
  spentDepositKeys: string[];
  spentDeposits: CommitmentData[];
  /** @deprecated use spentDepositKeys[0] */
  spentDepositKey: string | null;
  /** @deprecated use spentDeposits[0] */
  spentDeposit: CommitmentData | null;
  /** Pool precommitment id for the change note — resolve after tx confirms. */
  changePoolId: string | null;
  /**
   * Map from localStorage key → server commitments table id.
   * Used to call markCommitmentSpent() after withdrawal so the server stays in sync.
   * Only populated for notes that were synced from the server.
   */
  serverCommitmentIds: Record<string, string>;
}

// --------- Utilities ----------
export function modField(value: bigint): bigint {
  return value % FIELD_SIZE;
}

/**
 * Parse a value to bigint, returning null for '', whitespace, undefined/null, or any string that
 * BigInt() can't parse. This exists because `BigInt('')` silently returns 0n (the ONE falsy string
 * that doesn't throw) — a note with an empty secret would otherwise compute a WRONG leaf
 * (Poseidon(amount, Poseidon(nullifier, 0))) and fail the circuit's Merkle assert opaquely at
 * "Withdrawal line 67". safeBigInt makes that corruption explicit so the note is quarantined+repaired
 * instead of proved. Also returns null-ish handling: callers additionally treat 0n as invalid, since
 * a real nullifier/secret is never zero.
 */
export function safeBigInt(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  try { return BigInt(s); } catch { return null; }
}

/**
 * Recompute a note's on-chain leaf from its raw secret material (Hard ASP):
 *   precommitment = Poseidon(nullifier, secret)
 *   leaf          = Poseidon(Poseidon(amountWei, label), precommitment)
 */
export async function reconstructLeaf(
  nullifier: bigint,
  secret: bigint,
  amountWei: bigint,
  label: bigint,
): Promise<{ precommitment: bigint; leaf: bigint; nullifierHash: bigint }> {
  const { hashPrecommitment, hashCommitment, poseidon1 } = await import('./noteCrypto');
  const precommitment = await hashPrecommitment(modField(nullifier), modField(secret));
  const leaf = await hashCommitment(modField(amountWei), modField(label), precommitment);
  const nullifierHash = await poseidon1(modField(nullifier));
  return { precommitment, leaf, nullifierHash };
}

export function encodeProof(proof: (string | bigint)[]): string {
  const hexParts = proof.map(p => {
    const bn = (typeof p === 'bigint') ? p : BigInt(p);
    return bn.toString(16).padStart(64, '0');
  });
  return '0x' + hexParts.join('');
}

// --------- Generate Commitment Data (for deposits) ----------
export async function generateCommitmentData(
  _chainId: number,
  _token: TokenInfo,
  _amount: string
): Promise<CommitmentData> {
  console.log("generateCommitmentData() called", { _chainId, _token: _token.symbol, _amount });
  
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Generate secret and nullifier
  const secret = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
  const nullifier = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
  
  // Apply field modulo
  const secretMod = modField(secret);
  const nullifierMod = modField(nullifier);

  // Calculate precommitment: H(nullifier, secret)
  const precommitmentHash = BigInt(F.toObject(poseidon([nullifierMod, secretMod])));
  const precommitment = precommitmentHash;

  // Calculate nullifier hash: H(nullifier)
  const nullifierHash = BigInt(F.toObject(poseidon([nullifierMod])));

  // Do not log precommitment / nullifierHash — console scrapers / XSS.

  // Note: commitment will be added after deposit transaction
  // Hard ASP: commitment = Poseidon(Poseidon(amount, label), precommitment)
  const commitmentData: CommitmentData = {
    secret: secretMod.toString(),
    nullifier: nullifierMod.toString(),
    precommitment: precommitment.toString(),
    amount: _amount,
    nullifierHash: nullifierHash.toString()
  };

  return commitmentData;
}

// Verbose on-chain logging is off by default (the periodic balance refresh made it spammy).
// Set NEXT_PUBLIC_ZK_DEBUG=1 to re-enable.
const ZK_DEBUG = process.env.NEXT_PUBLIC_ZK_DEBUG === '1';
const zlog = (...args: unknown[]) => { if (ZK_DEBUG) console.log(...args); };

// A token's vault + merkleTree addresses never change — resolve once per chain and cache.
const vaultInfoCache = new Map<string, { vault: Contract; merkleTreeAddress: string }>();
export async function resolveVault(
  tokenAddress: string,
  chainId?: number,
): Promise<{ vault: Contract; merkleTreeAddress: string }> {
  const net = getNetwork(chainId ?? getSelectedChainId());
  const cacheKey = `${net.chainId}:${tokenAddress.toLowerCase()}`;
  const hit = vaultInfoCache.get(cacheKey);
  if (hit) return hit;
  const provider = getReadProvider(net.chainId);
  const entrypoint = new Contract(
    net.entrypoint,
    entrypointArtifact.abi as ethers.InterfaceAbi,
    provider,
  );
  // Retry these — an intermittently-lagging upstream returns an empty 0x (CALL_EXCEPTION) for
  // these state reads, which otherwise blanks the whole balance / output-note resolve.
  const vaultAddress = await withRetry(() => entrypoint.getVault(tokenAddress));
  // An unregistered token resolves to the zero address, whose merkleTree() also answers 0x — the
  // same BAD_DATA as a lagging RPC, but permanent. Name it, so a bad entrypoint/token pairing does
  // not masquerade as a transient read (and does not sit through six pointless retries).
  if (!vaultAddress || vaultAddress === ethers.ZeroAddress) {
    throw new Error(
      `No vault registered for token ${tokenAddress} on chain ${net.chainId} ` +
        `(entrypoint ${net.entrypoint})`,
    );
  }
  const vault = new Contract(vaultAddress, nativeVaultAbiJson.abi as ethers.InterfaceAbi, provider);
  const merkleTreeAddress = await withRetry(() => vault.merkleTree());
  const info = { vault, merkleTreeAddress };
  vaultInfoCache.set(cacheKey, info);
  return info;
}

// The leaf set is FUND-CRITICAL: the proof builder folds it into a Merkle root, and any gap /
// wrong-order produces a root that never existed on-chain → InvalidStateRoot. The previous
// incremental/persistent cache could leave a PERMANENT gap — a leaf in the same block as the
// saved lastBlock that the RPC hadn't indexed when that block was first scanned is never re-read
// (the next scan starts at lastBlock+1) — which silently corrupts every later index. We now FULL
// SCAN every time (cheap on a paid RPC) and purge any stale cache from older builds once.
const LEAF_PERSIST_PREFIX = 'siphon-leafscan-';
let _leafCachePurged = false;
function purgeStaleLeafScanCache(): void {
  if (_leafCachePurged || typeof localStorage === 'undefined') return;
  _leafCachePurged = true;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEAF_PERSIST_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

/**
 * True while an auto-merge for `symbol` is in flight — a `merge-hint-*` entry exists (written when
 * the merge tx is sent, removed after the consolidated note is persisted). During this window the
 * input notes are already spent but the merged output leaf isn't selectable yet, so selection would
 * transiently report "no spendable note". Lets callers show "consolidating, wait" instead.
 */
function hasPendingMergeFor(symbol: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('merge-hint-')) continue;
      const row = JSON.parse(localStorage.getItem(k) || '{}');
      if (String(row.symbol || '').toUpperCase() === symbol.toUpperCase()) return true;
    }
  } catch { /* ignore */ }
  return false;
}

// --------- Helper: Get on-chain leaves ----------
// Short-TTL cache of the ORDERED leaf array (NOT a deduped Set — the Merkle path depends on the
// exact index ordering, incl. any duplicate leaf values). Shared by the balance poll AND the
// withdraw so they don't each fire a full chunked getLogs scan through the slow serverless proxy;
// an in-flight promise map collapses concurrent callers onto ONE scan. A slightly stale set only
// ever MISSES a brand-new leaf — the note being spent is an existing leaf at a stable index, and a
// lagging set folds to a recent historical root the vault still accepts. invalidateLeafCache()
// (called after deposits / output-note resolves) clears it so new deposits show promptly.
const orderedLeavesCache = new Map<string, { leaves: bigint[]; ts: number }>();
const orderedLeavesInflight = new Map<string, Promise<bigint[]>>();
const ORDERED_LEAVES_TTL_MS = 45_000;

export async function getOnChainLeaves(tokenAddress: string, chainId?: number): Promise<bigint[]> {
  zlog("getOnChainLeaves() tokenAddress:", tokenAddress);
  const net = getNetwork(chainId ?? getSelectedChainId());
  const cacheKey = `${net.chainId}:${tokenAddress.toLowerCase()}`;

  const cached = orderedLeavesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ORDERED_LEAVES_TTL_MS) return cached.leaves;
  const inflight = orderedLeavesInflight.get(cacheKey);
  if (inflight) return inflight;

  const scan = (async (): Promise<bigint[]> => {
    let _lt = armTrace("leaves:scanStart");
    const provider = getReadProvider(net.chainId);
    const { merkleTreeAddress } = await resolveVault(tokenAddress, net.chainId);
    _lt = armTrace("leaves:resolveVault", _lt);
    zlog("MerkleTree address:", merkleTreeAddress);

    const asset = assetSymbolForToken(tokenAddress, net.chainId);
    const mt = new Contract(
      merkleTreeAddress,
      [
        "function getSize() view returns (uint256)",
        "function getRoot() view returns (uint256)",
        "function rootExists(uint256) view returns (bool)",
      ],
      provider,
    );

    // P1: incremental indexer sync (public leaves only) + root integrity checks.
    // P2: if indexer lags size, poll briefly before any RPC; prefer bounded catch-up over
    // deploy→head. Lagging-but-known roots are OK for proofs (P0 / knownRoots).
    let pHash: Poseidon2 | null = null;
    const getHash = async (): Promise<Poseidon2> => {
      if (pHash) return pHash;
      const poseidon = await buildPoseidon();
      const F = poseidon.F;
      pHash = (a, b) => BigInt(F.toObject(poseidon([a, b])));
      return pHash;
    };

    const readHints = async () => {
      const onChainSize = Number(BigInt((await withRetry(() => mt.getSize())).toString()));
      const onChainRoot = BigInt((await withRetry(() => mt.getRoot())).toString());
      return {
        onChainSize,
        onChainRoot,
        rootExists: async (root: bigint) =>
          Boolean(await withRetry(() => mt.rootExists(root), 2)),
      };
    };

    if (asset) {
      try {
        const hash = await getHash();
        _lt = armTrace("leaves:getHash", _lt);
        let hints = await readHints();
        _lt = armTrace(`leaves:readHints(onChainSize=${hints.onChainSize})`, _lt);
        let synced = await syncMerkleLeaves({
          chainId: net.chainId,
          asset,
          tree: merkleTreeAddress,
          fetchPage: (c, a, from) => fetchIndexedLeavesPage(c, a, from),
          hints,
          hash,
        });

        _lt = armTrace(
          `leaves:syncMerkleLeaves(ok=${synced.ok}${synced.ok ? `,n=${synced.leaves.length}` : `,reason=${synced.reason}`})`,
          _lt,
        );

        // P2: short indexer poll when behind head (avoids immediate RPC).
        if (synced.ok && synced.leaves.length < hints.onChainSize) {
          for (let i = 0; i < 3 && synced.ok && synced.leaves.length < hints.onChainSize; i++) {
            await sleep(400);
            hints = await readHints();
            synced = await syncMerkleLeaves({
              chainId: net.chainId,
              asset,
              tree: merkleTreeAddress,
              fetchPage: (c, a, from) => fetchIndexedLeavesPage(c, a, from),
              hints,
              hash,
            });
          }
        }

        if (synced.ok && synced.leaves.length > 0) {
          // Prefer returning when caught up; otherwise still usable for proofs if knownRoots OK.
          zlog(
            `Leaves from incremental sync (fetched=${synced.fetched}, cached=${synced.fromCache}, size=${synced.leaves.length}/${hints.onChainSize}):`,
            synced.leaves.length,
          );
          if (synced.leaves.length >= hints.onChainSize) {
            orderedLeavesCache.set(cacheKey, { leaves: synced.leaves, ts: Date.now() });
            return synced.leaves;
          }
          _lt = armTrace("leaves:pollLoopDone → tryRpcLeafCatchup", _lt);
          // Behind head after poll — try bounded RPC catch-up before accepting lag / full scan.
          const catchup = await tryRpcLeafCatchup({
            provider,
            merkleTreeAddress,
            chainId: net.chainId,
            asset,
            baseLeaves: synced.leaves,
            deployBlock: vaultDeployBlock(net.chainId),
            hints,
            hash,
          });
          _lt = armTrace(`leaves:tryRpcLeafCatchup(${catchup ? `n=${catchup.length}` : "null"})`, _lt);
          if (catchup) {
            orderedLeavesCache.set(cacheKey, { leaves: catchup, ts: Date.now() });
            return catchup;
          }
          orderedLeavesCache.set(cacheKey, { leaves: synced.leaves, ts: Date.now() });
          return synced.leaves;
        }
        if (synced.ok === false) {
          zlog("Incremental sync rejected:", synced.reason, "— trying legacy full indexer / RPC");
        }
      } catch (e) {
        zlog("Incremental sync failed — RPC path:", e);
      }
    }

    _lt = armTrace("leaves:fallthrough → legacy fetchIndexedLeaves", _lt);
    // Legacy full indexer dump (older servers / sync miss) with size+root gate.
    const indexed = await fetchIndexedLeaves(net.chainId, asset);
    armTrace(`leaves:fetchIndexedLeaves(${indexed ? `n=${indexed.length}` : "null"})`, _lt);
    if (indexed && indexed.length > 0) {
      try {
        const hints = await readHints();
        if (hints.onChainSize === indexed.length) {
          const hash = await getHash();
          const folded = MerkleTreeView.fromLeaves(indexed, hash).root;
          if (folded === hints.onChainRoot) {
            zlog("Leaves from indexer full dump (size+root verified):", indexed.length);
            orderedLeavesCache.set(cacheKey, { leaves: indexed, ts: Date.now() });
            return indexed;
          }
          zlog("Indexer full dump root mismatch — RPC path");
          clearMerkleLeafStore(net.chainId, asset ?? undefined, merkleTreeAddress);
        } else {
          zlog(`Indexer stale (has ${indexed.length}, on-chain ${hints.onChainSize}) — RPC path`);
        }
      } catch (e) {
        zlog("Indexer size-verify failed — RPC path:", e);
      }
    }

    purgeStaleLeafScanCache();

    // P2 RPC: bounded catch-up from tipBlock when possible; full deploy→head only as last resort.
    const hash = await getHash();
    const hints = await readHints();
    const baseSnap =
      asset ? loadLeafSnapshot(net.chainId, asset, merkleTreeAddress) : null;
    const baseLeaves = baseSnap?.leaves.map((s) => BigInt(s)) ?? [];

    const catchup = await tryRpcLeafCatchup({
      provider,
      merkleTreeAddress,
      chainId: net.chainId,
      asset: asset ?? "ETH",
      baseLeaves,
      deployBlock: vaultDeployBlock(net.chainId),
      hints,
      hash,
      allowFullScan: true,
    });
    if (catchup && catchup.length > 0) {
      orderedLeavesCache.set(cacheKey, { leaves: catchup, ts: Date.now() });
      return catchup;
    }

    throw new MerkleTreeError("Unable to load merkle leaves from indexer or RPC");
  })().finally(() => orderedLeavesInflight.delete(cacheKey));

  orderedLeavesInflight.set(cacheKey, scan);
  return scan;
}

/** P2: eth_getLogs LeafInserted from tipBlock−overlap (or deploy if allowFullScan). */
async function tryRpcLeafCatchup(opts: {
  provider: ethers.Provider;
  merkleTreeAddress: string;
  chainId: number;
  asset: string;
  baseLeaves: bigint[];
  deployBlock: number;
  hints: {
    onChainSize: number;
    onChainRoot: bigint;
    rootExists: (root: bigint) => Promise<boolean>;
  };
  hash: Poseidon2;
  allowFullScan?: boolean;
}): Promise<bigint[] | null> {
  const {
    provider,
    merkleTreeAddress,
    chainId,
    asset,
    baseLeaves,
    deployBlock,
    hints,
    hash,
    allowFullScan = false,
  } = opts;

  const snap = loadLeafSnapshot(chainId, asset, merkleTreeAddress);
  const tipBlock = snap?.tipBlock ?? null;
  const latest = await provider.getBlockNumber();
  // Empty base cannot catch up from a mid-tree tip — need full history or indexer.
  const plan =
    baseLeaves.length === 0
      ? ({ mode: "full" as const, fromBlock: Math.max(0, deployBlock) })
      : planLeafLogScan({
          deployBlock,
          latestBlock: latest,
          tipBlock,
        });

  if (plan.mode === "full" && !allowFullScan) {
    zlog("RPC catch-up skipped (full scan required but not allowed in this path)");
    return null;
  }

  zlog(
    `RPC leaf ${plan.mode} scan from block ${plan.fromBlock} → ${latest}` +
      (tipBlock != null ? ` (tipBlock=${tipBlock})` : ""),
  );

  const LEAF_INSERTED_TOPIC = ethers.id("LeafInserted(uint256,uint256,uint256)");
  const rawLogs = await getLogsChunked(
    provider,
    { address: merkleTreeAddress, topics: [LEAF_INSERTED_TOPIC] },
    plan.fromBlock,
    latest,
  );

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const events: LeafInsertedEvent[] = rawLogs.map((log) => {
    const [index, leaf, root] = abiCoder.decode(["uint256", "uint256", "uint256"], log.data);
    return {
      index: BigInt(index.toString()),
      leaf: BigInt(leaf.toString()),
      root: BigInt(root.toString()),
      blockNumber: log.blockNumber,
    };
  });

  if (plan.mode === "full") {
    events.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    for (let i = 0; i < events.length; i++) {
      if (events[i].index !== BigInt(i)) {
        zlog(`RPC full scan gapped at index ${i} (got ${events[i].index})`);
        return null;
      }
    }
    const leaves = events.map((e) => e.leaf);
    const tipRoot = leaves.length ? MerkleTreeView.fromLeaves(leaves, hash).root : hints.onChainRoot;
    const verified = await verifySyncedLeaves(
      leaves,
      tipRoot,
      hints,
      hash,
    );
    if (!verified.ok) {
      zlog("RPC full scan failed verify:", verified.reason);
      return null;
    }
    const tipBlk = events.length ? Math.max(...events.map((e) => e.blockNumber)) : undefined;
    saveLeafSnapshot({
      v: MERKLE_LEAF_CACHE_VERSION,
      chainId,
      asset: asset.toUpperCase(),
      tree: merkleTreeAddress.toLowerCase(),
      leaves: leaves.map((l) => l.toString()),
      tipRoot: verified.tipRoot.toString(),
      tipBlock: tipBlk,
      savedAt: Date.now(),
    });
    zlog("Leaves from RPC full scan:", leaves.length);
    return leaves;
  }

  // Catch-up merge onto base
  const merged = mergeLeafInsertedCatchup(baseLeaves, events);
  if (!merged.ok) {
    zlog("RPC catch-up merge failed:", merged.reason);
    return null;
  }
  const verified = await verifySyncedLeaves(
    merged.leaves,
    null,
    hints,
    hash,
  );
  if (!verified.ok) {
    zlog("RPC catch-up verify failed:", verified.reason);
    return null;
  }
  saveLeafSnapshot({
    v: MERKLE_LEAF_CACHE_VERSION,
    chainId,
    asset: asset.toUpperCase(),
    tree: merkleTreeAddress.toLowerCase(),
    leaves: merged.leaves.map((l) => l.toString()),
    tipRoot: verified.tipRoot.toString(),
    tipBlock: merged.tipBlock > 0 ? merged.tipBlock : tipBlock ?? undefined,
    savedAt: Date.now(),
  });
  zlog(
    `Leaves from RPC catch-up: ${merged.leaves.length} (was ${baseLeaves.length}, mode=${plan.mode})`,
  );
  return merged.leaves;
}

// --------- Resolve a pending "output note" from a vault-mode swap ----------
// When a vault-mode swap strategy is submitted, the browser pre-generates an output note's
// secret/precommitment but the amount + commitment aren't known until the swap actually runs
// (slippage). The executor re-deposits the realized output and emits Deposited(...). We learn
// the final amount + commitment by reading that on-chain event for our precommitment.
// Returns { amount, commitment } (decimal strings) or null if the deposit isn't on-chain yet.
/** Newest ChangeLabeled events searched when resolving a re-shielded swap output. */
const MAX_RESHIELD_SCAN = 200;

export async function resolveOutputNote(
  tokenAddress: string,
  precommitment: string,
  chainId?: number,
): Promise<{ amount: string; commitment: string; label?: string } | null> {
  const net = getNetwork(chainId ?? getSelectedChainId());

  // Indexer first — vault_deposit is keyed by (chain_id, precommitment). found:false falls
  // through to the authoritative RPC scan (the deposit may be on-chain but not indexed yet).
  const indexed = await fetchIndexedDeposit(net.chainId, BigInt(precommitment).toString());
  if (indexed) return indexed;

  const provider = getReadProvider(net.chainId);
  const { vault } = await resolveVault(tokenAddress, net.chainId);
  const vaultAddress = vault.target as string;

  // Deposited(address indexed depositor, uint256 amount, uint256 commitment, uint256 precommitment, uint256 label, uint256 nonce)
  const DEPOSITED_TOPIC = ethers.id("Deposited(address,uint256,uint256,uint256,uint256,uint256)");
  const latest = await provider.getBlockNumber();
  const logs = await getLogsChunked(
    provider,
    { address: vaultAddress, topics: [DEPOSITED_TOPIC] },
    vaultDeployBlock(net.chainId),
    latest,
  );

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const target = BigInt(precommitment).toString();
  for (const log of logs) {
    const [amount, commitment, pre, label] = abiCoder.decode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      log.data,
    );
    if (BigInt(pre.toString()).toString() === target) {
      return {
        amount: BigInt(amount.toString()).toString(),
        commitment: BigInt(commitment.toString()).toString(),
        label: BigInt(label.toString()).toString(),
      };
    }
  }

  return resolveReShieldedOutputNote(provider, vaultAddress, net.chainId, BigInt(precommitment), latest);
}

/**
 * Recover a note created by Entrypoint.swapAndDeposit (the atomic re-shield).
 *
 * That path does NOT emit Deposited — it emits ChangeLabeled(label, commitment) plus the tree's
 * LeafInserted. So neither the indexer (whose vault_deposit rows are keyed on Deposited) nor the
 * Deposited scan above can ever find a swap output: both return nothing, resolvePendingOutputNotes
 * skips the note forever, and the swapped balance is invisible in the UI even though the leaf is
 * on-chain and correctly labelled.
 *
 * ChangeLabeled gives (label, commitment) but not the amount, which is only known post-slippage.
 * Recover it from the vault's inflow in the same transaction and then PROVE the pairing:
 *   commitment == Poseidon(Poseidon(amount, label), precommitment)
 * Only public inputs are involved, so a wrong candidate is rejected rather than trusted — that
 * check is what makes reading the amount out of a Transfer log safe.
 */
async function resolveReShieldedOutputNote(
  provider: ethers.Provider,
  vaultAddress: string,
  chainId: number,
  precommitment: bigint,
  latest: number,
): Promise<{ amount: string; commitment: string; label: string } | null> {
  const CHANGE_LABELED_TOPIC = ethers.id('ChangeLabeled(uint256,uint256)');
  const logs = await getLogsChunked(
    provider,
    { address: vaultAddress, topics: [CHANGE_LABELED_TOPIC] },
    vaultDeployBlock(chainId),
    latest,
  );
  if (!logs.length) return null;

  const { hashCommitment } = await import('./noteCrypto');
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  // Newest first: a pending output note is by definition recent, so the match is normally the
  // first candidate. Bounded because each candidate costs a receipt fetch and a mature vault can
  // hold thousands of ChangeLabeled events — an unbounded scan would hang the balance refresh.
  const candidates = logs.slice(-MAX_RESHIELD_SCAN).reverse();

  for (const log of candidates) {
    let label: bigint;
    let commitment: bigint;
    try {
      label = BigInt(log.topics[1]);
      commitment = BigInt(abiCoder.decode(['uint256'], log.data)[0].toString());
    } catch {
      continue;
    }
    for (const amount of await vaultInflowCandidates(provider, log.transactionHash, vaultAddress)) {
      if ((await hashCommitment(amount, label, precommitment)) === commitment) {
        return {
          amount: amount.toString(),
          commitment: commitment.toString(),
          label: label.toString(),
        };
      }
    }
  }
  return null;
}

/** Candidate amounts for the re-shielded output; see vaultInflow.ts for why each one exists. */
async function vaultInflowCandidates(
  provider: ethers.Provider,
  txHash: string,
  vault: string,
): Promise<bigint[]> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return [];
  const out = vaultInflowCandidatesFromLogs(receipt.logs, vault);
  // Last resort: a native credit that left no usable log at all. Block-scoped, so it is wrong if
  // another tx credited the vault in the same block — only reached when nothing above was found.
  if (!out.length && receipt.blockNumber > 0) {
    try {
      const [after, before] = await Promise.all([
        provider.getBalance(vault, receipt.blockNumber),
        provider.getBalance(vault, receipt.blockNumber - 1),
      ]);
      if (after > before) out.push(after - before);
    } catch { /* no archive access — the caller just finds no match */ }
  }
  return out;
}

// Reverse of resolveOutputNote: recover the precommitment (and amount) for a known on-chain
// commitment by reading the Deposited event. Needed to repair a note whose stored precommitment
// was lost (e.g. syncWalletNotesFromServer writes precommitment:'') — the precommitment is the key
// to fetch the authoritative nullifier/secret from the precommitment backup row.
// Returns { amount, precommitment } (decimal strings) or null if the commitment isn't on-chain.
export async function resolvePrecommitmentByCommitment(
  tokenAddress: string,
  commitment: string,
  chainId?: number,
): Promise<{ amount: string; precommitment: string; label?: string } | null> {
  const net = getNetwork(chainId ?? getSelectedChainId());
  const provider = getReadProvider(net.chainId);
  const { vault } = await resolveVault(tokenAddress, net.chainId);
  const vaultAddress = vault.target as string;

  const DEPOSITED_TOPIC = ethers.id("Deposited(address,uint256,uint256,uint256,uint256,uint256)");
  const latest = await provider.getBlockNumber();
  const logs = await getLogsChunked(
    provider,
    { address: vaultAddress, topics: [DEPOSITED_TOPIC] },
    vaultDeployBlock(net.chainId),
    latest,
  );

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const target = BigInt(commitment).toString();
  for (const log of logs) {
    const [amount, comm, pre, label] = abiCoder.decode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      log.data,
    );
    if (BigInt(comm.toString()).toString() === target) {
      return {
        amount: BigInt(amount.toString()).toString(),
        precommitment: BigInt(pre.toString()).toString(),
        label: BigInt(label.toString()).toString(),
      };
    }
  }
  return null;
}

// --------- True (on-chain-reconciled) vault balance ----------
// The naive balance sums every localStorage note, which over-counts: strategy "change" notes
// are saved as spendable before the withdrawal that creates them confirms, so an un-executed
// strategy leaves a phantom note. The real spendable balance only counts a note when:
//   1) its commitment is an actual on-chain leaf (the deposit/change really happened), AND
//   2) its nullifier hasn't been spent on-chain (it hasn't already been withdrawn).

interface TokenMeta { address: string; decimals: number; symbol: string }
export interface SpendableBalance {
  totalBalance: number;
  /** ASP-admitted — privately withdrawable ("deposited"). */
  details: Record<string, number>;
  /** Original deposits still Pending — screening in flight ("in checking"). */
  checking: Record<string, number>;
  /** Original deposits Revoked — ragequit from Activity. */
  flagged: Record<string, number>;
  /** Tokens whose leaf set could not be verified — caller must keep the previous display. */
  skipped: string[];
}

/**
 * Per-note split. Live chain revocation wins over the HTTP association set. Pending
 * labels become privately spendable once the published association set contains them.
 * Unlabeled notes are omitted (not dumped into checking).
 */
async function splitLiveNotesByAsp(
  signer: import("ethers").Signer,
  live: Array<{ storageKey: string; amount: string; commitment?: string }>,
  vault: Contract,
): Promise<{ deposited: number; checking: number; flagged: number; unresolved: number }> {
  const { readNote } = await import("./localNoteStore");
  const { labelInAssociationSet } = await import("./aspProof");
  const { readDepositInfo, classifyAspNote, LABEL_PENDING } = await import("./depositLabel");

  const infoCache = new Map<string, Awaited<ReturnType<typeof readDepositInfo>>>();
  const aspCache = new Map<string, boolean>();

  let deposited = 0;
  let checking = 0;
  let flagged = 0;
  let unresolved = 0;

  for (const c of live) {
    const amt = parseFloat(c.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const data = await readNote(c.storageKey, signer);
    const label = String(data?.label || "").trim();
    if (!label || label === "0") {
      // Decrypt failed or label sealed — keep the amount visible as unresolved.
      unresolved += amt;
      continue;
    }

    if (!infoCache.has(label)) infoCache.set(label, await readDepositInfo(vault, label));
    const info = infoCache.get(label) ?? null;
    if (!info) continue; // wrong vault generation — omit from private balance
    let inAsp = false;
    if (info.status === LABEL_PENDING) {
      if (!aspCache.has(label)) aspCache.set(label, await labelInAssociationSet(label));
      inAsp = aspCache.get(label) === true;
    }
    const access = classifyAspNote(info.status, inAsp);

    if (access === "spent") continue;
    if (access === "flagged") flagged += amt;
    else if (access === "deposited") deposited += amt;
    else checking += amt;
  }
  return { deposited, checking, flagged, unresolved };
}

/**
 * Count the connected wallet's ASP-ADMITTED (spendable) notes for a token — labels that are in the
 * association set and not revoked/spent ("deposited"). Used by the post-deposit auto-consolidate trigger:
 * only admitted notes are mergeable (a checking note isn't in the ASP tree, so dual-inclusion would fail),
 * so the >= 6 threshold must count admitted notes, not all unspent ones.
 */
export async function countAdmittedNotes(
  chainId: number,
  token: TokenInfo,
): Promise<number> {
  const signer = getSigner();
  if (!signer || typeof window === "undefined") return 0;
  const tokenAddress = token.symbol === "ETH" ? NATIVE_TOKEN : token.address;
  let vault: Contract;
  try {
    ({ vault } = await resolveVault(tokenAddress, chainId));
  } catch {
    return 0;
  }
  const { scanNoteMeta, readNote } = await import("./localNoteStore");
  const { labelInAssociationSet } = await import("./aspProof");
  const { readDepositInfo, classifyAspNote, LABEL_PENDING } = await import("./depositLabel");

  const infoCache = new Map<string, Awaited<ReturnType<typeof readDepositInfo>>>();
  const aspCache = new Map<string, boolean>();
  let admitted = 0;
  for (const meta of scanNoteMeta(`${chainId}-${token.symbol}-`)) {
    if (meta.spent === "true" || !meta.amount) continue;
    const data = await readNote(meta.key, signer);
    const label = String(data?.label || "").trim();
    if (!label || label === "0") continue;
    if (!infoCache.has(label)) infoCache.set(label, await readDepositInfo(vault, label));
    const info = infoCache.get(label) ?? null;
    if (!info) continue;
    let inAsp = false;
    if (info.status === LABEL_PENDING) {
      if (!aspCache.has(label)) aspCache.set(label, await labelInAssociationSet(label));
      inAsp = aspCache.get(label) === true;
    }
    if (classifyAspNote(info.status, inAsp) === "deposited") admitted++;
  }
  return admitted;
}

// Cache the leaf scan — expensive (many eth_getLogs). Refresh infrequently.
const leavesCache = new Map<string, { leaves: Set<string>; ts: number }>();
const leavesInflight = new Map<string, Promise<Set<string> | null>>();
const LEAVES_TTL_MS = 600_000; // 10 min

export function invalidateLeafCache(tokenAddress?: string) {
  // Soft invalidate: force the next getOnChainLeaves to re-talk to indexer/chain.
  // Do NOT wipe the persistent incremental leaf store — that would re-download all leaves
  // and recreate the scaling problem P1 fixed. Corruption / tree redeploy clears inside sync.
  if (tokenAddress) {
    const cacheKey = `${getNetwork().chainId}:${tokenAddress.toLowerCase()}`;
    leavesCache.delete(cacheKey);
    leavesInflight.delete(cacheKey);
    orderedLeavesCache.delete(cacheKey);
    orderedLeavesInflight.delete(cacheKey);
  } else {
    leavesCache.clear();
    leavesInflight.clear();
    orderedLeavesCache.clear();
    orderedLeavesInflight.clear();
  }
}

/**
 * Leaf set for DISPLAY paths (balance ghost-filter, sync ghost-filter). Returns a set the
 * caller may trust, or NULL when no trustworthy set is cheaply available — callers must then
 * SKIP membership filtering (the nullifier check remains the authoritative spent test).
 *
 * A stale indexer set must never be returned: filtering against it classifies fresh
 * deposits as "not on-chain" and erases real funds from the display. And a mere display
 * refresh must never trigger the full chunked-getLogs scan — that is reserved for proof
 * paths, which need the exact ordered set regardless of cost.
 */
export async function getLeafSet(tokenAddress: string, chainId?: number): Promise<Set<string> | null> {
  const net = getNetwork(chainId ?? getSelectedChainId());
  const cacheKey = `${net.chainId}:${tokenAddress.toLowerCase()}`;
  const hit = leavesCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < LEAVES_TTL_MS) return hit.leaves;

  const pending = leavesInflight.get(cacheKey);
  if (pending) return pending;

  const task = (async (): Promise<Set<string> | null> => {
    const asset = assetSymbolForToken(tokenAddress, net.chainId);
    if (!asset) return null;

    try {
      const { merkleTreeAddress } = await resolveVault(tokenAddress, net.chainId);
      const mt = new Contract(
        merkleTreeAddress,
        [
          "function getSize() view returns (uint256)",
          "function getRoot() view returns (uint256)",
          "function rootExists(uint256) view returns (bool)",
        ],
        getReadProvider(net.chainId),
      );
      const onChainSize = Number(BigInt((await withRetry(() => mt.getSize())).toString()));
      const onChainRoot = BigInt((await withRetry(() => mt.getRoot())).toString());
      const poseidon = await buildPoseidon();
      const F = poseidon.F;
      const pHash: Poseidon2 = (a, b) => BigInt(F.toObject(poseidon([a, b])));

      const hintsBase = {
        onChainSize,
        onChainRoot,
        rootExists: async (root: bigint) =>
          Boolean(await withRetry(() => mt.rootExists(root), 2)),
      };

      let synced = await syncMerkleLeaves({
        chainId: net.chainId,
        asset,
        tree: merkleTreeAddress,
        fetchPage: (c, a, from) => fetchIndexedLeavesPage(c, a, from),
        hints: hintsBase,
        hash: pHash,
      });

      // P2: brief indexer poll then bounded RPC catch-up (display needs exact size).
      if (synced.ok && synced.leaves.length < onChainSize) {
        for (let i = 0; i < 3 && synced.ok && synced.leaves.length < onChainSize; i++) {
          await sleep(400);
          const sizeNow = Number(BigInt((await withRetry(() => mt.getSize())).toString()));
          const rootNow = BigInt((await withRetry(() => mt.getRoot())).toString());
          synced = await syncMerkleLeaves({
            chainId: net.chainId,
            asset,
            tree: merkleTreeAddress,
            fetchPage: (c, a, from) => fetchIndexedLeavesPage(c, a, from),
            hints: {
              onChainSize: sizeNow,
              onChainRoot: rootNow,
              rootExists: hintsBase.rootExists,
            },
            hash: pHash,
          });
        }
      }

      let leaves: bigint[] | null = synced.ok ? synced.leaves : null;
      const sizeTarget = Number(BigInt((await withRetry(() => mt.getSize())).toString()));
      if (leaves && leaves.length < sizeTarget) {
        const rootNow = BigInt((await withRetry(() => mt.getRoot())).toString());
        const catchup = await tryRpcLeafCatchup({
          provider: getReadProvider(net.chainId),
          merkleTreeAddress,
          chainId: net.chainId,
          asset,
          baseLeaves: leaves,
          deployBlock: vaultDeployBlock(net.chainId),
          hints: {
            onChainSize: sizeTarget,
            onChainRoot: rootNow,
            rootExists: hintsBase.rootExists,
          },
          hash: pHash,
        });
        if (catchup) leaves = catchup;
      }

      // Display filter must not use a lagging set (hides fresh deposits). Proofs may.
      if (!leaves || leaves.length !== sizeTarget) {
        zlog(
          `[getLeafSet] sync unusable for display ` +
            `(${leaves ? leaves.length : synced.ok ? "n/a" : synced.reason}/${sizeTarget}) — no leaf filter`,
        );
        return null;
      }

      const set = new Set(leaves.map((l) => l.toString()));
      leavesCache.set(cacheKey, { leaves: set, ts: Date.now() });
      return set;
    } catch {
      return null; // can't verify — don't trust, don't scan
    }
  })();

  leavesInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    leavesInflight.delete(cacheKey);
  }
}

// Multicall3 — same canonical address on Base, Sepolia, and ~every EVM chain. Lets us check
// many nullifiers in ONE eth_call instead of one round-trip per note.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];

/**
 * Batch `vault.nullifiers(hash)` lookups into a single Multicall3 call. Returns a boolean per
 * input hash (true = spent). On any failure, falls back to "not spent" for that entry so a
 * flaky check never hides a real note.
 */
async function checkNullifiersSpent(
  provider: ethers.Provider,
  vault: Contract,
  vaultAddress: string,
  nullifierHashes: string[],
): Promise<Array<boolean | null>> {
  if (nullifierHashes.length === 0) return [];
  const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const calls = nullifierHashes.map((h) => ({
    target: vaultAddress,
    allowFailure: true,
    callData: vault.interface.encodeFunctionData('nullifiers', [BigInt(h)]),
  }));
  const results: Array<{ success: boolean; returnData: string }> = await withRetry(() =>
    mc.aggregate3(calls),
  );
  // null = UNKNOWN, not "unspent". Returning false for a failed sub-call made the balance count an
  // already-spent note as spendable, which overstates funds — the one direction a balance must
  // never err in. The caller decides what to do with an unknown; it must not silently become live.
  return results.map((r) => {
    if (!r.success) return null;
    try {
      const [spent] = vault.interface.decodeFunctionResult('nullifiers', r.returnData);
      return Boolean(spent);
    } catch {
      return null;
    }
  });
}

/**
 * Last successfully reconciled figures per chain, per symbol.
 *
 * `skipped` means "could not verify this token — keep the previous display", but EVERY call site
 * destructures only `details` and throws `skipped` away (UserDash, ConnectButton x2, WalletPanel).
 * So a skipped token did not keep its previous value, it disappeared. ETH and USDC fail
 * independently — an inconclusive nullifier read on one, an unresolved ASP split on the other — so
 * the dashboard showed one or the other and never both, flapping on every refresh. Restoring here
 * fixes all four callers at once instead of asking each to remember.
 */
const lastGoodBalance = new Map<string, {
  details: Record<string, number>;
  checking: Record<string, number>;
  flagged: Record<string, number>;
}>();

export async function getSpendableVaultBalance(
  chainId: number,
  tokenMap: Record<string, TokenMeta>,
): Promise<SpendableBalance> {
  // Key the carry-forward cache by WALLET too. Keyed on chain alone, switching accounts would
  // show the previous wallet's private balance for any token the new pass could not verify.
  let cacheKey = `${chainId}:unknown`;
  try {
    const addr = await getSigner()?.getAddress();
    if (addr) cacheKey = `${chainId}:${addr.toLowerCase()}`;
  } catch { /* no signer — falls back to the shared 'unknown' bucket */ }

  const { scanNoteMeta } = await import('./localNoteStore');
  const notesByToken: Record<string, Array<{
    commitment?: string;
    nullifierHash?: string;
    amount: string;
    storageKey: string;
    vaultId?: string;
  }>> = {};
  const newNotePrefix = `siphon-note-${chainId}-`;
  for (const meta of scanNoteMeta(`${chainId}-`)) {
    if (meta.spent === 'true') continue;
    const parts = meta.key.split('-');
    const symIdx = meta.key.startsWith(newNotePrefix) ? 3 : 1;
    if (parts.length <= symIdx) continue;
    const sym = parts[symIdx].toUpperCase();
    (notesByToken[sym] ||= []).push({
      commitment:    meta.commitment,
      nullifierHash: meta.nullifierHash,
      amount:        meta.amount,
      storageKey:    meta.key,
      vaultId:       meta.vaultId,
    });
  }

  const details: Record<string, number> = {};
  const checking: Record<string, number> = {};
  const flagged: Record<string, number> = {};
  const skipped: string[] = [];
  let totalBalance = 0;

  for (const [sym, notes] of Object.entries(notesByToken)) {
    const tok = tokenMap[sym];
    if (!tok) continue;
    const tokenAddress = sym === 'ETH' ? NATIVE_TOKEN : tok.address;

    let vault: Contract;
    try {
      ({ vault } = await resolveVault(tokenAddress, chainId));
    } catch (e) {
      console.warn(`[balance] reconcile failed for ${sym}:`, e);
      skipped.push(sym);
      continue;
    }

    const signer = getSigner();
    if (!signer) {
      skipped.push(sym);
      continue;
    }

    // Spendable here means "a leaf in THIS vault's tree". Every retired generation (soft-era,
    // v1–v4) shares the chain id, so scanNoteMeta hands us their notes too — and their nullifiers
    // read UNSPENT against the current vault because they were never in it. Without this gate they
    // counted as spendable: the dashboard reported 1.979 ETH while the live v5 ETH vault held
    // 0.021 ETH. Old-generation funds are real but only reachable via the legacy-migration path.
    // Use the INDEXED leaf list, not getOnChainLeaves. This is a display gate, so it does not need
    // the root-verified scan that proof building does — and that scan's readHints() does on-chain
    // getSize()/getRoot() through a rate-limited RPC, each wrapped in withRetry (6 tries, backoff to
    // 4s). Measured at 34-69s, which blows the 12s balance budget and leaves the dashboard stuck on
    // "keeping last display". The indexer answers the same question in <1s.
    // GENERATION FILTER via vault_id (local/Supabase), not the indexer. Every retired generation
    // shares the chain id, so we must keep only notes belonging to THIS generation. The vault_id
    // column answers that from local data — no indexer needed, so the balance renders even when no
    // indexer serves this vault. The indexer's leaf set, if reachable, is used only as an OPTIONAL
    // refinement below (to drop a note that isn't actually a leaf yet); its absence never stalls.
    const { currentVaultId } = await import('./vaultRegistry');
    const curVaultId = await currentVaultId(chainId, sym);

    // Optional: the indexed leaf set. Never a hard gate — failure is tolerated.
    let leafSet: Set<string> | null = null;
    try {
      const indexed = await fetchIndexedLeaves(chainId, sym);
      if (indexed) leafSet = new Set(indexed.map((l) => l.toString()));
    } catch { /* indexer optional — vault_id is the generation gate */ }

    const counted = new Set<string>();
    const candidates: Array<{ commitment: string; nullifierHash?: string; amount: string; storageKey: string; legacy: boolean }> = [];
    for (const n of notes) {
      if (!n.commitment || counted.has(n.commitment)) continue;
      counted.add(n.commitment);

      // Generation membership:
      //  - vault_id === '1'  → legacy pre-ASP bucket: trusted from the synced note (source of truth),
      //    ASP checks skipped (they predate the association set). Kept as a spendable candidate.
      //  - vault_id === curVaultId → current generation. Kept.
      //  - a known OTHER generation → excluded (belongs to a retired vault / migration path).
      //  - vault_id absent (un-backfilled note) → fall back to the indexer leaf test if available,
      //    else keep as a candidate (the nullifier + ASP checks below still guard correctness).
      const vid = n.vaultId;
      const isLegacy = vid === '1';
      let keep: boolean;
      if (isLegacy) {
        keep = true;
      } else if (vid != null && curVaultId != null) {
        keep = vid === curVaultId;
      } else if (leafSet) {
        // no vault_id known — use the indexer leaf membership if we have it
        try { keep = leafSet.has(BigInt(n.commitment).toString()); } catch { keep = false; }
      } else {
        keep = true; // unknown generation, no indexer — defer to spent/ASP checks below
      }
      if (!keep) continue;

      candidates.push({
        commitment: n.commitment,
        nullifierHash: n.nullifierHash,
        amount: n.amount,
        storageKey: n.storageKey,
        legacy: isLegacy,
      });
    }

    // A note counts as spendable ONLY if we positively verified it is not spent. Treating an
    // unverifiable note as live is what let an already-spent note keep showing: after a swap the
    // dashboard read 3 USDC when the wallet held 1.01 — the 2 USDC input the swap consumed, plus
    // its 1 USDC change. Overstating a private balance is worse than showing a stale one, because
    // the user arms a strategy against money that is no longer there.
    const withNh = candidates.filter((c) => c.nullifierHash);
    const spentByNh = new Map<string, boolean | null>();
    try {
      const flags = await checkNullifiersSpent(
        getReadProvider(chainId),
        vault,
        await vault.getAddress(),
        withNh.map((c) => c.nullifierHash!),
      );
      withNh.forEach((c, i) => spentByNh.set(c.nullifierHash!, flags[i] ?? null));
    } catch (e) {
      // Unreconcilable — keep the last good display rather than inventing an inflated one.
      console.warn(`[balance] nullifier check failed for ${sym}; keeping last display:`, e);
      skipped.push(sym);
      continue;
    }

    // READ-ONLY. This is the balance display; it must never write spent state.
    //
    // It used to call markNoteSpentByKey here, and syncFromServer then pushes local spent=true up
    // to Supabase where the rank merge makes it ONE-WAY (localNoteStore.ts). So a single wrong
    // vault resolution, a wrong-generation nullifier read, or a multicall glitch would bury a live
    // note permanently, on every device that syncs — a rendering bug turning into lost funds.
    // Only the withdraw path, which holds a tx receipt proving the spend, may mark a note spent.
    const live: typeof candidates = [];
    let rpcUnknown = 0;   // the chain could not tell us — a transient read problem
    let noHash = 0;       // this note has no nullifierHash stored, so it can never be checked
    for (const c of candidates) {
      if (!c.nullifierHash) { noHash++; continue; }
      const spent = spentByNh.get(c.nullifierHash);
      if (spent === true) continue;              // proven spent
      if (spent !== false) { rpcUnknown++; continue; }  // null/absent => unknown, never "unspent"
      live.push(c);
    }
    if (rpcUnknown > 0) {
      // A read failed, so this total would be a guess. Keep the last good display instead — the
      // same choice the indexed-leaf failure above makes, for the same reason.
      console.warn(`[balance] ${rpcUnknown} ${sym} nullifier read(s) inconclusive; keeping last display`);
      skipped.push(sym);
      continue;
    }
    if (noHash > 0) {
      // Permanent data gap, not a transient one: skipping the whole token would hide the balance
      // for ever. Leave those notes out of the spendable total and say so.
      console.warn(`[balance] ${noHash} ${sym} note(s) have no nullifierHash — excluded from spendable`);
    }

    if (live.length === 0) continue;

    // Legacy (vault_id='1') notes predate the ASP — trust them from the synced note as spendable
    // (deposited), skip the ASP split. Their unspent-check already passed above.
    const legacyLive = live.filter((c) => c.legacy);
    const aspLive    = live.filter((c) => !c.legacy);
    let legacyDeposited = 0;
    for (const c of legacyLive) {
      const amt = parseFloat(c.amount);
      if (Number.isFinite(amt) && amt > 0) legacyDeposited += amt;
    }
    if (legacyDeposited > 0) {
      details[sym] = (details[sym] ?? 0) + legacyDeposited;
      totalBalance += legacyDeposited;
    }

    if (aspLive.length === 0) continue;

    try {
      const split = await splitLiveNotesByAsp(signer, aspLive, vault);
      // Nothing classified and some notes unresolved → incomplete (keep previous display).
      if (split.unresolved > 0 && split.deposited + split.checking + split.flagged === 0) {
        skipped.push(sym);
        continue;
      }
      if (split.deposited > 0) details[sym] = (details[sym] ?? 0) + split.deposited;
      // Only genuine ASP-pending notes are "checking" — not decrypt/classify gaps.
      if (split.checking > 0) checking[sym] = split.checking;
      if (split.flagged > 0) flagged[sym] = split.flagged;
      // Unclassified but live notes default to deposited (optimistic) — never fake "checking".
      if (split.unresolved > 0) {
        details[sym] = (details[sym] ?? 0) + split.unresolved;
      }
      totalBalance += split.deposited + split.unresolved;
    } catch (e) {
      console.warn(`[balance] ASP split failed for ${sym} — keeping previous display:`, e);
      skipped.push(sym);
    }
  }

  // Carry forward anything this pass could not verify, then remember the merged view so a token
  // survives repeated failures rather than only the first one.
  const prev = lastGoodBalance.get(cacheKey);
  if (prev) {
    for (const sym of skipped) {
      if (prev.details[sym]  != null) details[sym]  = prev.details[sym];
      if (prev.checking[sym] != null) checking[sym] = prev.checking[sym];
      if (prev.flagged[sym]  != null) flagged[sym]  = prev.flagged[sym];
    }
  }
  lastGoodBalance.set(cacheKey, {
    details:  { ...details },
    checking: { ...checking },
    flagged:  { ...flagged },
  });
  // totalBalance is the spendable figure the header shows; keep it consistent with `details`
  // after restoration, or a restored token would be visible per-asset but missing from the total.
  totalBalance = Object.values(details).reduce((a, b) => a + b, 0);

  return { totalBalance, details, checking, flagged, skipped };
}

/** Sum unspent note amounts in localStorage for a chain (may include not-yet-indexed deposits). */
export function getLocalVaultNoteTotals(chainId: number): Record<string, number> {
  const details: Record<string, number> = {};
  if (typeof window === "undefined") return details;

  const newPrefix    = `siphon-note-${chainId}-`;
  const legacyPrefix = `${chainId}-`;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    const isNew    = key.startsWith(newPrefix);
    const isLegacy = !isNew && key.startsWith(legacyPrefix);
    if (!isNew && !isLegacy) continue;

    // Extract symbol: new format = siphon-note-{chainId}-{SYM}-{commitment} (part index 3)
    //                 legacy      = {chainId}-{SYM}-{commitment}             (part index 1)
    const parts = key.split("-");
    const symIdx = isNew ? 3 : 1;
    if (parts.length <= symIdx) continue;
    const sym = parts[symIdx].toUpperCase();
    try {
      const d = JSON.parse(localStorage.getItem(key) || "{}");
      if (!d?.amount || d.spent === true || d.spent === "true") continue;
      if (!d.commitment) continue;
      // Dedup: if a new-format encrypted entry exists for this commitment, skip the plaintext one
      if (!isNew && d.commitment) {
        const newKey = `siphon-note-${chainId}-${sym}-${d.commitment}`;
        if (localStorage.getItem(newKey)) continue;
      }
      const amt = parseFloat(String(d.amount));
      if (!Number.isFinite(amt)) continue;
      details[sym] = (details[sym] || 0) + amt;
    } catch {
      /* skip */
    }
  }
  return details;
}

/** Unspent notes written recently (or still pending) — used to overlay a just-made deposit
 * onto the last good on-chain split without waiting for the indexer. */
export function getFreshLocalCheckingTotals(chainId: number): Record<string, number> {
  const details: Record<string, number> = {};
  if (typeof window === "undefined") return details;
  const now = Date.now();
  // Only covers the gap before the ASP/indexer has SEEN a just-mined deposit; once they have,
  // the reconciled split classifies it correctly and this overlay must stand down. Measured
  // deposit→provable is ~132s, so 45min meant an admitted note was dragged back into "in
  // checking" for the rest of the hour, permanently disagreeing with the reconciled split.
  // Safe to under-shoot: overlayFreshChecking only ever Math.max()es INTO checking, so a note
  // the ASP still reports as unscreened keeps showing as checking on the authoritative side.
  // ponytail: age heuristic, not a real admission check — swap for labelInAssociationSet(label)
  // if this ever needs to be exact (requires making the overlay async).
  const FRESH_MS = 5 * 60 * 1000;
  const newPrefix = `siphon-note-${chainId}-`;
  // Notes are keyed by chain + symbol + commitment, NOT by vault, so a kernel cutover leaves the
  // old generation's rows sitting in the same keyspace. v3 rows record the generation they belong
  // to; anything tagged with a different one is filtered out below.
  const activeVaultId = (() => {
    try {
      const k = v3ConfigFor(chainId)?.vaultKernel;
      return k ? `v3-${k}` : null;
    } catch { return null; }
  })();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(newPrefix)) continue;
    const parts = key.split("-");
    if (parts.length <= 3) continue;
    const sym = parts[3].toUpperCase();
    try {
      const d = JSON.parse(localStorage.getItem(key) || "{}");
      // v3 rows carry `value` (wei) and no `amount`; v2 rows carry `amount` (human decimal).
      // Requiring `amount` skipped every v3 note, so a fresh v3 deposit never appeared as pending.
      if ((!d?.amount && !d?.value) || !d.commitment) continue;
      if (d.spent === true || d.spent === "true") continue;
      // Stale notes from a RETIRED vault generation are still valid rows, but they are not
      // spendable here and their leaves are in a different tree. Without this a kernel cutover
      // leaves the previous generation's notes showing as "in review" forever, against an ASP
      // watcher that is indexing a different contract and will never admit them.
      if (activeVaultId && d.vaultId && d.vaultId !== activeVaultId) continue;
      const fresh = d.spent === "pending" || (typeof d.createdAt === "number" && now - d.createdAt < FRESH_MS);
      if (!fresh) continue;
      const amt = localNoteAmountToHuman(d, getTokens(chainId)[sym]?.decimals ?? 18);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      details[sym] = (details[sym] || 0) + amt;
    } catch { /* skip */ }
  }
  return details;
}

// --------- Generate ZK Data (for withdrawals) ----------
export interface SwapBinding {
  pool: string;
  dstToken: string;
  fee: number | bigint;
  minAmountOut: bigint | string;
}

const MAX_NOTES = 6;

/**
 * Build a MerkleTreeView from an ordered leaf snapshot and bind a circuit stateRoot that the
 * vault will accept. Always proves against the snapshot root (not a live getRoot() that can
 * race the leaf fetch). Rejects gapped/corrupt snapshots via rootExists.
 */
async function merkleSnapshotForProof(
  leaves: bigint[],
  hash: Poseidon2,
  merkleTreeContract: Contract,
): Promise<{ tree: MerkleTreeView; stateRoot: bigint; liveRoot: bigint }> {
  if (leaves.length === 0) {
    throw new MerkleTreeError("cannot prove against an empty leaf snapshot");
  }
  const tree = MerkleTreeView.fromLeaves(leaves, hash);
  // Smoke: path math must be self-consistent before we talk to chain.
  if (!tree.verifyIndex(0, hash)) {
    throw new MerkleTreeError("internal: merkle level cache failed self-check");
  }
  const liveRoot = BigInt((await withRetry(() => merkleTreeContract.getRoot())).toString());
  const stateRoot = await assertUsableMerkleRoot(tree.root, liveRoot, async (root) =>
    Boolean(await withRetry(() => merkleTreeContract.rootExists(root), 2)),
  );
  return { tree, stateRoot, liveRoot };
}

export interface SwapProofData {
  amountIn: string;        // wei routed into the swap
  stateRoot: string;
  aspRoot: string;
  nullifier: string;       // nullifierHash — on-chain spent key for the input note
  newCommitment: string;   // change note inserted into the tree
  newLabel: string;
  recipient: string;       // swap-output recipient (bound to proof)
  pool: string;
  dstToken: string;
  fee: number;
  minAmountOut: string;
  srcToken: string;        // input asset (NATIVE sentinel or ERC20)
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  spentNoteKey: string;    // localStorage key of the note being spent
  // change note secrets so the caller can persist/track the remainder
  change: { nullifier: string; secret: string; precommitment: string; commitment: string; amountWei: string; label: string };
}

/**
 * Build an atomic-swap proof for ONE note → Vault.swap. The reusable core for limit / TWAP /
 * grid slices: spends a single note (specific `_noteKey`, or the smallest note ≥ amountIn),
 * routes `_amountIn` through the swap bound to recipient/pool/dstToken/fee/minOut, and mints a
 * change note for the remainder. The executor later submits the returned struct via
 * Entrypoint.swap — it never custodies funds and never sees the note secrets.
 */
export async function generateSwapProof(
  _chainId: number,
  _inToken: TokenInfo,
  _amountIn: string,
  _recipient: string,
  _swap: SwapBinding,
  _noteKey?: string,
): Promise<SwapProofData | { error: string }> {
  let _ts = armTrace("swapProof:start");
  const poseidon = await buildPoseidon();
  _ts = armTrace("swapProof:buildPoseidon", _ts);
  const F = poseidon.F;
  const pHash = (a: bigint, b: bigint): bigint => BigInt(F.toObject(poseidon([a, b])));
  const pHash1 = (a: bigint): bigint => BigInt(F.toObject(poseidon([a])));

  const tokenAddress = _inToken.symbol === 'ETH' ? NATIVE_TOKEN : _inToken.address;
  const amountInWei = BigInt(ethers.parseUnits(_amountIn, _inToken.decimals).toString());
  if (amountInWei <= 0n) return { error: "Swap amountIn must be > 0." };

  const signer = getSigner();
  if (!signer) return { error: "Wallet not connected." };

  // 1. on-chain leaves + root
  let leaves: bigint[];
  try {
    // NON-deduped, index-ordered leaves — the Merkle path depends on exact on-chain positions.
    // getLeafSet returns a Set, which silently drops a DUPLICATE leaf value and shifts every later
    // index by one → the circuit folds to a root that never existed on-chain (InvalidStateRoot /
    // failed root check). Duplicate leaf values do occur (e.g. zero-value change notes).
    leaves = await getOnChainLeaves(tokenAddress, _chainId);
  } catch {
    return { error: "Failed to fetch on-chain leaves for swap proof." };
  }
  _ts = armTrace(`swapProof:getOnChainLeaves(${leaves.length} leaves)`, _ts);
  const { vault, merkleTreeAddress } = await resolveVault(tokenAddress, _chainId);
  _ts = armTrace("swapProof:resolveVault", _ts);
  const provider = getReadProvider(_chainId);
  const merkleTreeContract = new Contract(merkleTreeAddress, merkleTreeAbiJson.abi as ethers.InterfaceAbi, provider);

  let tree: MerkleTreeView;
  let stateRoot: bigint;
  try {
    ({ tree, stateRoot } = await merkleSnapshotForProof(leaves, pHash, merkleTreeContract));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Merkle snapshot unusable for swap: ${msg}` };
  }
  _ts = armTrace("swapProof:merkleSnapshot", _ts);

  // 2. select the note to spend (specific key, or smallest unspent note ≥ amountIn)
  const { scanNoteMeta, readNote, markNoteSpent } = await import('./localNoteStore');
  const metas = scanNoteMeta(`${_chainId}-${_inToken.symbol}-`);
  _ts = armTrace(`swapProof:scanNoteMeta(${metas.length} metas)`, _ts);
  type SwapCandidate = { key: string; data: CommitmentData; amountWei: bigint; leafIndex: number; nullifierHash: bigint };
  const candidates: Array<{ amountWei: bigint; value: SwapCandidate }> = [];
  for (const meta of metas) {
    if (_noteKey && meta.key !== _noteKey) continue;
    if (!meta.commitment || !meta.amount) continue;
    if (meta.spent === 'true') continue;
    const data = await readNote(meta.key, signer);
    if (!data || !data.nullifier || !data.commitment) continue;
    const amountWei = BigInt(ethers.parseUnits(data.amount.toString(), _inToken.decimals).toString());
    if (amountWei < amountInWei) continue;
    const leafIndex = leaves.findIndex(l => l === BigInt(data.commitment));
    if (leafIndex === -1) continue;
    // Integrity: array slot must still hold this commitment (guards accidental index mixups).
    if (tree.leafAt(leafIndex) !== BigInt(data.commitment)) continue;
    candidates.push({
      amountWei,
      value: {
        key: meta.key,
        data: { ...data, precommitment: data.precommitment ?? '' },
        amountWei,
        leafIndex,
        nullifierHash: pHash1(BigInt(data.nullifier)),
      },
    });
  }
  _ts = armTrace(`swapProof:readNoteLoop(${candidates.length} candidates)`, _ts);
  const chosen = await selectSmallestUnspent(
    candidates,
    // Same flaky-upstream empty-0x as resolveVault's reads: unwrapped, one "missing revert data"
    // kills the whole arm after the proof work is already done.
    (candidate) => withRetry(() => vault.nullifiers(candidate.nullifierHash)),
    (candidate) => markNoteSpent(candidate.key),
  );
  _ts = armTrace(`swapProof:selectSmallestUnspent(chosen=${chosen ? "yes" : "no"})`, _ts);
  if (!chosen) {
    // Better error when balance is split across multiple deposits (each needs its own note ≥ amountIn).
    let maxNote = 0n;
    let total = 0n;
    for (const meta of metas) {
      if (meta.spent === 'true' || !meta.amount) continue;
      const data = await readNote(meta.key, signer);
      if (!data) continue;
      try {
        const w = BigInt(ethers.parseUnits(data.amount.toString(), _inToken.decimals).toString());
        if (w > maxNote) maxNote = w;
        total += w;
      } catch { /* skip */ }
    }
    if (total >= amountInWei && maxNote < amountInWei) {
      return {
        error: `No single ${_inToken.symbol} note ≥ ${_amountIn} (largest deposit: ${ethers.formatUnits(maxNote, _inToken.decimals)}; ${ethers.formatUnits(total, _inToken.decimals)} total). Swap up to the largest deposit, run multiple swaps, or deposit the full amount once.`,
      };
    }
    return { error: `No spendable ${_inToken.symbol} note ≥ ${_amountIn} found.` };
  }

  try {
    const { assertHardAspLive } = await import("./hardAspLive");
    await assertHardAspLive(_chainId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Hard ASP not live" };
  }
  _ts = armTrace("swapProof:assertHardAspLive", _ts);

  // 3. change note (remainder = inValue - amountIn; 0 for a full-slice spend)
  const changeValue = chosen.amountWei - amountInWei;
  const change = await generateCommitmentData(_chainId, _inToken, ethers.formatUnits(changeValue, _inToken.decimals));
  const inLabel = String(chosen.data.label || "").trim();
  if (!inLabel || inLabel === "0") {
    return { error: "swap note missing Hard ASP label" };
  }
  const { deriveOutputLabel, loadAspWitnessOne } = await import("./aspProof");
  const { hashCommitment } = await import("./noteCrypto");
  let newLabel: string;
  try {
    newLabel = await deriveOutputLabel([inLabel]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "ASP label inherit failed" };
  }
  _ts = armTrace("swapProof:changeNote+inheritLabel", _ts);
  const aspW = await loadAspWitnessOne(inLabel);
  _ts = armTrace(`swapProof:loadAspWitnessOne(${"error" in aspW ? "ERROR" : "ok"})`, _ts);
  if ("error" in aspW) return { error: aspW.error };

  // 4. build the swap witness (signal names match swap.circom Hard ASP)
  const { pathElements, pathIndices } = tree.path(chosen.leafIndex);
  if (tree.fold(tree.leafAt(chosen.leafIndex), { pathElements, pathIndices }, pHash) !== stateRoot) {
    return { error: "Merkle path does not fold to snapshot root — refresh and retry." };
  }
  const nullifierHash = chosen.nullifierHash;
  const changeCommitment = await hashCommitment(
    changeValue,
    BigInt(newLabel),
    BigInt(change.precommitment),
  );

  const circuitInput = {
    amountIn:      amountInWei.toString(),
    stateRoot:     stateRoot.toString(),
    aspRoot:       aspW.aspRoot,
    newCommitment: changeCommitment.toString(),
    newLabel,
    nullifierHash: nullifierHash.toString(),
    recipient:     BigInt(_recipient).toString(),
    pool:          BigInt(_swap.pool).toString(),
    dstToken:      BigInt(_swap.dstToken).toString(),
    fee:           BigInt(_swap.fee).toString(),
    minAmountOut:  BigInt(_swap.minAmountOut).toString(),
    inValue:       chosen.amountWei.toString(),
    inNullifier:   chosen.data.nullifier.toString(),
    inSecret:      chosen.data.secret.toString(),
    inLabel,
    pathElements:  pathElements.map(v => v.toString()),
    pathIndices:   pathIndices.map(String),
    aspPathElements: aspW.aspPathElements,
    aspPathIndices:  aspW.aspPathIndices,
    changeNullifier: change.nullifier.toString(),
    changeSecret:    change.secret.toString(),
  };

  _ts = armTrace("swapProof:witnessBuilt → calling prepareSwapTransaction", _ts);
  const { proof, publicSignals } = await prepareSwapTransaction(circuitInput);
  armTrace("swapProof:prepareSwapTransaction DONE", _ts);
  // Hard ASP: [amountIn, stateRoot, aspRoot, newCommitment, newLabel, nullifierHash, recipient, pool, dstToken, fee, minOut]
  const newCommitmentOnChain = publicSignals[3];
  const newLabelOnChain = publicSignals[4];

  return {
    amountIn:      amountInWei.toString(),
    stateRoot:     stateRoot.toString(),
    aspRoot:       aspW.aspRoot,
    nullifier:     nullifierHash.toString(),
    newCommitment: newCommitmentOnChain,
    newLabel:      newLabelOnChain,
    recipient:     _recipient,
    pool:          _swap.pool,
    dstToken:      _swap.dstToken,
    fee:           Number(_swap.fee),
    minAmountOut:  BigInt(_swap.minAmountOut).toString(),
    srcToken:      tokenAddress,
    pA: proof.pA as [string, string],
    pB: proof.pB as [[string, string], [string, string]],
    pC: proof.pC as [string, string],
    spentNoteKey:  chosen.key,
    change: {
      nullifier:     change.nullifier,
      secret:        change.secret,
      precommitment: change.precommitment,
      commitment:    newCommitmentOnChain,
      amountWei:     changeValue.toString(),
      label:         newLabelOnChain,
    },
  };
}

const SPLIT_N = 8;

export interface SplitSliceNote {
  nullifier: string; secret: string; precommitment: string; commitment: string; amountWei: string; label: string;
}
export interface SplitProofData {
  stateRoot: string;
  aspRoot: string;
  nullifierHash: string;       // input note spent on-chain
  outCommitments: string[];    // all 8 (on-chain insert order)
  outLabel: string;            // single inherited Hard ASP label (== inLabel), applied to all outputs
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  spentNoteKey: string;        // localStorage key of the note being split
  totalValue: string;          // input note value (wei) → split()'s _totalValue for slice DepositInfo
  slices: SplitSliceNote[];    // the real (non-zero) slice notes to persist + swap later
}

/**
 * Split ONE note into `_sliceCount` equal slice-notes (+ zero-pad to 8) for a TWAP/grid.
 * One private tx (Entrypoint.split) — hides the slice amounts and count (always 8 commitments),
 * removing the deposit-side fingerprint of N separate deposits. The returned `slices` are the
 * independent notes each future swap proof will spend.
 */
export async function generateSplitProof(
  _chainId: number,
  _token: TokenInfo,
  _sliceCount: number,
  _noteKey?: string,
): Promise<SplitProofData | { error: string }> {
  if (_sliceCount < 1 || _sliceCount > SPLIT_N) return { error: `sliceCount must be 1..${SPLIT_N}` };

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const pHash = (a: bigint, b: bigint): bigint => BigInt(F.toObject(poseidon([a, b])));
  const pHash1 = (a: bigint): bigint => BigInt(F.toObject(poseidon([a])));

  const tokenAddress = _token.symbol === 'ETH' ? NATIVE_TOKEN : _token.address;
  const signer = getSigner();
  if (!signer) return { error: "Wallet not connected." };

  // 1. on-chain leaves + root
  let leaves: bigint[];
  try {
    // NON-deduped, index-ordered leaves — the Merkle path depends on exact on-chain positions.
    // getLeafSet returns a Set, which silently drops a DUPLICATE leaf value and shifts every later
    // index by one → the circuit folds to a root that never existed on-chain (InvalidStateRoot /
    // failed root check). Duplicate leaf values do occur (e.g. zero-value change notes).
    leaves = await getOnChainLeaves(tokenAddress, _chainId);
  } catch {
    return { error: "Failed to fetch on-chain leaves for split." };
  }
  const { vault, merkleTreeAddress } = await resolveVault(tokenAddress, _chainId);
  const provider = getReadProvider(_chainId);
  const merkleTreeContract = new Contract(merkleTreeAddress, merkleTreeAbiJson.abi as ethers.InterfaceAbi, provider);

  let tree: MerkleTreeView;
  let stateRoot: bigint;
  try {
    ({ tree, stateRoot } = await merkleSnapshotForProof(leaves, pHash, merkleTreeContract));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Merkle snapshot unusable for split: ${msg}` };
  }

  // 1b. Sync server commitments into localStorage so the split can see notes created on another
  // device / after a localStorage clear — mirrors generateZKData's hydration. Without this a note
  // that exists only in Supabase (spent='false') is invisible to the localStorage-only scan below,
  // surfacing as a false "No spendable ETH note found to split" even though the balance shows funds.
  try {
    const { fetchCommitments } = await import('./commitmentStore');
    const { noteKey: mkNoteKey, writeNote, readNote } = await import('./localNoteStore');
    const serverComms = await fetchCommitments(signer);
    for (const c of serverComms) {
      if (c.spent !== 'false') continue;
      const key = mkNoteKey(Number(c.decrypted.chainId), String(c.asset), c.decrypted.commitment);
      const existingReadable = await readNote(key, signer);
      if (!existingReadable) {
        await writeNote(key, {
          nullifier:     c.decrypted.nullifier,
          secret:        c.decrypted.secret,
          commitment:    c.decrypted.commitment,
          amount:        c.decrypted.amount,
          nullifierHash: c.decrypted.nullifierHash ?? '',
          precommitment: c.decrypted.precommitment ?? '',
          label:         c.decrypted.label != null ? String(c.decrypted.label) : undefined,
          vaultAddress:  c.decrypted.vaultAddress,
          spent:         false,
        }, signer);
      }
    }
  } catch (e) {
    console.warn('[split] server commitment hydration failed, using localStorage only', e);
  }

  // 2. select the note to split (specific key, or largest unspent note)
  const { scanNoteMeta, readNote, markNoteSpent } = await import('./localNoteStore');
  const metas = scanNoteMeta(`${_chainId}-${_token.symbol}-`);
  let chosen: { key: string; data: CommitmentData; amountWei: bigint; leafIndex: number } | null = null;
  for (const meta of metas) {
    if (_noteKey && meta.key !== _noteKey) continue;
    if (!meta.commitment || !meta.amount) continue;
    if (meta.spent === 'true') continue;
    const data = await readNote(meta.key, signer);
    if (!data || !data.nullifier || !data.commitment) continue;
    const amountWei = BigInt(ethers.parseUnits(data.amount.toString(), _token.decimals).toString());
    if (amountWei <= 0n) continue;
    const leafIndex = leaves.findIndex(l => l === BigInt(data.commitment));
    if (leafIndex === -1) continue;
    if (tree.leafAt(leafIndex) !== BigInt(data.commitment)) continue;
    if (await withRetry(() => vault.nullifiers(pHash1(BigInt(data.nullifier))))) { markNoteSpent(meta.key); continue; }
    if (_noteKey || !chosen || amountWei > chosen.amountWei) {
      chosen = { key: meta.key, data: { ...data, precommitment: data.precommitment ?? '' }, amountWei, leafIndex };
      if (_noteKey) break;
    }
  }
  if (!chosen) return { error: `No spendable ${_token.symbol} note found to split.` };

  try {
    const { assertHardAspLive } = await import("./hardAspLive");
    await assertHardAspLive(_chainId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Hard ASP not live" };
  }

  // 3. slice amounts: equal, remainder folded into the last real slice (conservation).
  // NOTE: this circuit derives each output commitment from outNullifier+outSecret, so every output
  // slice MUST be user-owned (the prover needs its secret). A protocol-owned fee slice is NOT
  // possible here — Part A collection happens separately (see buildLegsFromSplit), not via the split.
  const V = chosen.amountWei;
  const base = V / BigInt(_sliceCount);

  // 4. build 8 output notes (real slices + zero pad) — Hard ASP nested commitment + inherited label
  const inLabel = String(chosen.data.label || "").trim();
  if (!inLabel || inLabel === "0") {
    return { error: "split note missing Hard ASP label" };
  }
  const { deriveOutputLabel, loadAspWitnessOne } = await import("./aspProof");
  const { hashCommitment } = await import("./noteCrypto");
  let outLabelBase: string;
  try {
    outLabelBase = await deriveOutputLabel([inLabel]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "ASP label inherit failed" };
  }
  const aspW = await loadAspWitnessOne(inLabel);
  if ("error" in aspW) return { error: aspW.error };

  const outValue: bigint[] = [];
  const outNote: SplitSliceNote[] = [];
  for (let i = 0; i < SPLIT_N; i++) {
    const v = i >= _sliceCount ? 0n : (i < _sliceCount - 1 ? base : V - base * BigInt(_sliceCount - 1));
    const cd = await generateCommitmentData(_chainId, _token, ethers.formatUnits(v, _token.decimals));
    const commitment = await hashCommitment(v, BigInt(outLabelBase), BigInt(cd.precommitment));
    outValue.push(v);
    outNote.push({
      nullifier: cd.nullifier, secret: cd.secret, precommitment: cd.precommitment,
      commitment: commitment.toString(), amountWei: v.toString(), label: outLabelBase,
    });
  }

  // 5. witness — path + stateRoot from the same snapshot (never a racing live getRoot).
  const { pathElements, pathIndices } = tree.path(chosen.leafIndex);
  if (tree.fold(tree.leafAt(chosen.leafIndex), { pathElements, pathIndices }, pHash) !== stateRoot) {
    return { error: "Merkle path does not fold to snapshot root — refresh and retry." };
  }

  const nullifierHash = pHash1(BigInt(chosen.data.nullifier));
  const circuitInput = {
    stateRoot:     stateRoot.toString(),
    aspRoot:       aspW.aspRoot,
    nullifierHash: nullifierHash.toString(),
    // Single inherited output label (all slices share it) — matches the 12-signal split circuit.
    outLabel:      outLabelBase,
    outCommitment: outNote.map(o => o.commitment),
    inValue:       V.toString(),
    inNullifier:   chosen.data.nullifier.toString(),
    inSecret:      chosen.data.secret.toString(),
    inLabel,
    pathElements:  pathElements.map(v => v.toString()),
    pathIndices:   pathIndices.map(String),
    aspPathElements: aspW.aspPathElements,
    aspPathIndices:  aspW.aspPathIndices,
    outValue:      outValue.map(v => v.toString()),
    outNullifier:  outNote.map(o => o.nullifier),
    outSecret:     outNote.map(o => o.secret),
  };

  const { proof, publicSignals } = await prepareSplitTransaction(circuitInput);
  // Hard ASP (12 signals): [stateRoot, aspRoot, nullifierHash, outLabel, outCommitment[8]]
  const outLabel = publicSignals[3];
  const outCommitments = publicSignals.slice(4, 4 + SPLIT_N);

  return {
    stateRoot:     stateRoot.toString(),
    aspRoot:       aspW.aspRoot,
    nullifierHash: nullifierHash.toString(),
    outCommitments,
    outLabel,
    pA: proof.pA as [string, string],
    pB: proof.pB as [[string, string], [string, string]],
    pC: proof.pC as [string, string],
    spentNoteKey:  chosen.key,
    totalValue:    V.toString(),
    slices:        outNote.slice(0, _sliceCount).map((s, i) => ({
      ...s,
      commitment: outCommitments[i] ?? s.commitment,
      label: outLabel ?? s.label,
    })),
  };
}

export async function generateZKData(
  _chainId: number,
  _token: TokenInfo,
  _amount: string,
  _recipient: string,
  _swap?: SwapBinding,
  _noteKey?: string,   // restrict spend to ONE specific note (TWAP/grid slice)
): Promise<ZKData | { error: string }> {
  console.log("generateZKData() called", { _chainId, _token: _token.symbol, _amount, _recipient, _swap });

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const poseidonHash = (a: bigint, b: bigint): bigint => BigInt(F.toObject(poseidon([a, b])));

  // 1. FETCH LEAVES
  const tokenAddress = _token.symbol === 'ETH' ? NATIVE_TOKEN : _token.address;
  let leaves: bigint[] = [];
  try {
    // NON-deduped, index-ordered leaves (see swap path): a Set drops duplicate leaf values and
    // shifts indices, producing a phantom Merkle root that the vault rejects (InvalidStateRoot).
    // Always bust the cache here — a stale/partial set from the balance scan (which runs every 60s
    // and can hit RPC 429s mid-scan) would produce a snapshotRoot the vault doesn't know, causing
    // the "note set out of sync" error even for a perfectly valid note.
    // Bust vault + leaf caches so a redeployment is picked up immediately.
    const _ck = `${_chainId}:${tokenAddress.toLowerCase()}`;
    vaultInfoCache.delete(_ck);
    orderedLeavesCache.delete(_ck);
    orderedLeavesInflight.delete(_ck);
    leaves = await getOnChainLeaves(tokenAddress, _chainId);
    console.log("Found leaves count:", leaves.length);
  } catch (err) {
    console.error("Failed to fetch on-chain leaves:", err);
    return { error: "Failed to connect to blockchain to verify deposits." };
  }

  // 2. Sync server commitments into localStorage.
  // Also build serverCommitmentIds map (localStorage key → server row id) so the
  // withdrawal path can call markCommitmentSpent() for each spent input note.
  const signer = getSigner();
  const serverCommitmentIds: Record<string, string> = {};
  if (signer) {
    try {
      const { fetchCommitments } = await import('./commitmentStore');
      const { writeNote, readNote } = await import('./localNoteStore');
      const serverComms = await fetchCommitments(signer);
      for (const c of serverComms) {
        // Key must match what scanNoteMeta returns (new-format), so the serverCommitmentIds
        // lookup in handler.ts finds the entry. Old-format key here caused a permanent miss.
        const { noteKey: mkNoteKey } = await import('./localNoteStore');
        const key = mkNoteKey(Number(c.decrypted.chainId), String(c.asset), c.decrypted.commitment);
        // Track server id for every unspent note so we can mark it spent after withdrawal.
        if (c.spent === 'false') {
          serverCommitmentIds[key] = c.id;
          // Write from server if: (a) key is absent, OR (b) key exists but is a metadata-only
          // entry (no nullifier_enc) — vault-mode output notes are stored as metadata-only until
          // resolvePendingOutputNotes runs, but generateZKData's old guard skipped them because
          // the key existed. Check for nullifier_enc to detect the unencrypted stub.
          // Overwrite from the server copy if the local note is absent, metadata-only, OR present
          // but UNDECRYPTABLE (e.g. a nullifier_enc corrupted by the old exportKey bug). readNote
          // returns null in all three cases; a readable local note is left untouched. The previous
          // guard only checked whether nullifier_enc *existed*, so a corrupt-but-present local note
          // blocked the server's good copy and stayed permanently unreadable.
          const existingReadable = await readNote(key, signer);
          const needsWrite = !existingReadable;
          if (needsWrite) {
            await writeNote(key, {
              nullifier:     c.decrypted.nullifier,
              secret:        c.decrypted.secret,
              commitment:    c.decrypted.commitment,
              amount:        c.decrypted.amount,
              nullifierHash: c.decrypted.nullifierHash ?? '',
              precommitment: c.decrypted.precommitment ?? '',
              label:         c.decrypted.label != null ? String(c.decrypted.label) : undefined,
              vaultAddress:  c.decrypted.vaultAddress,
              spent:         false,
            }, signer);
          }
        }
      }
    } catch (e) {
      console.warn('Server commitment fetch failed, using localStorage only', e);
    }
  }

  // 3. MERKLE SNAPSHOT — build once, bind a vault-accepted stateRoot (live or historical).
  // Do this before note selection so a corrupt/gapped leaf set fails fast.
  const provider = getReadProvider(_chainId);
  const entrypoint = new Contract(
    getNetwork(_chainId).entrypoint,
    entrypointArtifact.abi as ethers.InterfaceAbi,
    provider,
  );
  const vaultAddr = await entrypoint.getVault(tokenAddress);
  const vaultContract = new Contract(vaultAddr, nativeVaultAbiJson.abi as ethers.InterfaceAbi, provider);
  const merkleTreeAddr = await vaultContract.merkleTree();
  const merkleTreeContract = new Contract(merkleTreeAddr, merkleTreeAbiJson.abi as ethers.InterfaceAbi, provider);

  let tree: MerkleTreeView;
  let stateRoot: bigint;
  let liveRoot: bigint;
  try {
    ({ tree, stateRoot, liveRoot } = await merkleSnapshotForProof(leaves, poseidonHash, merkleTreeContract));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Could not build a valid proof against the current chain state (${msg}) — refresh and retry in a moment.` };
  }
  console.log("✅ Snapshot root:", stateRoot.toString(), stateRoot === liveRoot ? "(live)" : "(historical, knownRoots)");
  if (stateRoot !== liveRoot) {
    console.debug("[Proof] leaf set lags live root — proving against recent historical root (knownRoots covers it)");
  }

  // 4. GREEDY MULTI-NOTE SELECTION
  // Collect all unspent, on-chain-confirmed notes, greedy-fill from largest to smallest.
  const withdrawnValueTotal = BigInt(ethers.parseUnits(_amount, _token.decimals).toString());

  const { vault: vaultForNullifier } = await resolveVault(tokenAddress, _chainId);
  const { scanNoteMeta, readNote, markNoteSpent } = await import('./localNoteStore');
  const _zkSigner = getSigner();
  const noteMetas = scanNoteMeta(`${_chainId}-${_token.symbol}-`);

  interface CandidateNote {
    key: string;
    data: CommitmentData;
    amountWei: bigint;
    leafIndex: number;
  }
  const candidates: CandidateNote[] = [];
  // Notes whose commitment IS on-chain but whose stored secret material doesn't reproduce that
  // leaf (corrupt/stale artifact from an older resolve). Kept out of candidates (the circuit would
  // reject them with a bare Merkle assert) and handed to the repair path below.
  const _inconsistent: Array<{ key: string; precommitment: string; commitment: string; amountWei: bigint }> = [];
  // Diagnostics: explain a "Have 0.0" instead of failing opaquely.
  const diag = { metas: noteMetas.length, spent: 0, unreadable: 0, zero: 0, nullified: 0, ghost: 0, badsecret: 0, ok: 0, noSigner: !_zkSigner };
  // Wrong-account / key-drift detection so an all-unreadable result yields a clear, actionable
  // error ("reconnect the original account") instead of a bare "Have 0.0".
  const _curWallet = _zkSigner ? (await _zkSigner.getAddress()).toLowerCase() : '';
  const _drifted = _zkSigner ? await (await import('./noteAuth')).encKeyDrifted(_zkSigner) : false;
  const foreignOwners = new Set<string>();
  // Unreadable notes stamped with THIS wallet. Tracked separately because "these notes belong to
  // another account" is only true when every unreadable note is someone else's — see the message
  // ladder below.
  let unreadableOwn = 0;

  for (const meta of noteMetas) {
    const key = meta.key;
    // TWAP/grid: spend exactly the named slice note, not a greedy mix of others.
    if (_noteKey && key !== _noteKey) continue;
    if (!meta.commitment || !meta.amount) continue;
    if (meta.spent === 'true') { diag.spent++; continue; }

    const data = _zkSigner ? await readNote(key, _zkSigner) : null;
    if (!data) {
      diag.unreadable++; // metadata-only / undecryptable (no spendable secret)
      const _owner = (meta.owner || '').toLowerCase();
      if (_owner && _curWallet && _owner !== _curWallet) foreignOwners.add(_owner);
      else unreadableOwn++;
      continue;
    }

    try {
      const amountWei = BigInt(ethers.parseUnits(data.amount.toString(), _token.decimals).toString());
      if (amountWei === 0n) { diag.zero++; continue; }

      // Nullifier spent check. Retry on transient RPC failure and DEFAULT TO UNSPENT on error,
      // mirroring the batched balance path (checkNullifiersSpent) — otherwise a single flaky
      // eth_call (429 / CALL_EXCEPTION) on this read drops a real, unspent note from candidates
      // and produces a false "Insufficient balance / Have 0.0". Only a definite on-chain `true`
      // skips the note; an error never hides funds.
      if (data.nullifier) {
        const nullifierHash = F.toString(poseidon([BigInt(data.nullifier)]));
        let isSpent = false;
        try {
          isSpent = await withRetry(() => vaultForNullifier.nullifiers(BigInt(nullifierHash)));
        } catch (e) {
          console.warn('[withdraw] nullifier check failed — treating as unspent (not dropping note):', key, e);
          isSpent = false;
        }
        if (isSpent) {
          markNoteSpent(key);
          diag.nullified++;
          continue;
        }
      }

      // On-chain commitment check
      const commitment = BigInt(data.commitment);
      const foundIndex = leaves.findIndex(leaf => leaf === commitment);
      if (foundIndex === -1) {
        console.warn("⚠️ Ghost Deposit (not on-chain):", key);
        diag.ghost++;
        continue;
      }
      if (tree.leafAt(foundIndex) !== commitment) {
        console.warn("⚠️ Leaf index integrity mismatch:", key, foundIndex);
        diag.ghost++;
        continue;
      }

      // Self-consistency gate (UNCONDITIONAL — the circuit's own check, mirrored). The withdrawal
      // circuit reconstructs the leaf from (amount, nullifier, secret) and asserts it's in the tree.
      // A note whose stored secret material does NOT reproduce its on-chain leaf passes the
      // commitment-membership check above but fails the in-circuit Merkle assert (the cryptic
      // "Withdrawal line 67"). This MUST run for EVERY note — NOT gated on `data.nullifier &&
      // data.secret` truthiness: an empty-string secret is falsy (slips a truthiness guard) AND
      // BigInt('')===0n (silently computes a WRONG leaf downstream), which is exactly how a corrupt
      // note reached the prover before. safeBigInt() returns null for ''/whitespace/garbage; a real
      // nullifier/secret is never 0n either. Any of those → quarantine for repair from the
      // authoritative Supabase precommitment row, never mint a doomed proof.
      const nBig = safeBigInt(data.nullifier);
      const sBig = safeBigInt(data.secret);
      let leafReproducesOnChain = false;
      if (nBig !== null && sBig !== null && nBig !== 0n && sBig !== 0n) {
        try {
          const labelBig = safeBigInt(data.label);
          if (labelBig === null || labelBig === 0n) {
            console.warn('[withdraw] note missing Hard ASP label — quarantining:', key);
            leafReproducesOnChain = false;
          } else {
            const { leaf, precommitment: rePre } = await reconstructLeaf(nBig, sBig, amountWei, labelBig);
            const onChainLeaf = leaves[foundIndex]; // the exact value the circuit must reproduce
            console.log('[withdraw-diag] leaf self-check', {
              key,
              amountWei: amountWei.toString(),
              label: labelBig.toString(),
              recomputedPrecommitment: rePre.toString(),
              precommitmentMatches: String(data.precommitment ?? '') === rePre.toString(),
              jsLeaf: leaf.toString(),
              onChainLeaf: onChainLeaf?.toString(),
              leafReproducesOnChain: leaf === onChainLeaf,
              leafIndex: foundIndex,
            });
            leafReproducesOnChain = leaf === onChainLeaf;
          }
        } catch (e) {
          console.warn('[withdraw] reconstructLeaf threw:', key, e);
          leafReproducesOnChain = false;
        }
      } else {
        console.warn('[withdraw] note has empty/zero secret material — quarantining for repair:', key,
          { nullifierNull: nBig === null, secretNull: sBig === null, nullifierZero: nBig === 0n, secretZero: sBig === 0n });
      }
      if (!leafReproducesOnChain) {
        // Corrupt/empty secret — the note can't produce a valid proof. Quarantine it for repair
        // from Supabase; NEVER hand it to the prover (it would fail the Merkle assert at line 67).
        diag.badsecret++;
        _inconsistent.push({ key, precommitment: data.precommitment ?? '', commitment: data.commitment, amountWei });
        continue;
      }

      candidates.push({ key, data: { ...data, precommitment: data.precommitment ?? '' }, amountWei, leafIndex: foundIndex });
      diag.ok++;
    } catch (e) {
      console.warn("Failed to process note", key, e);
    }
  }

  console.log(`[withdraw] ${_token.symbol} note triage:`,
    { ...diag, wallet: _curWallet, drifted: _drifted, unreadableOwn, foreignOwners: [...foreignOwners] },
    '— unreadable = metadata-only/undecryptable (no secret); ghost = commitment not in on-chain leaf set.',
    'unreadableOwn > 0 means the blocking notes are THIS wallet\'s, whatever foreignOwners lists.');

  // 4b. Cross-label privately-spendable selection — greedy fill across all ASP-admitted notes.
  const { labelInAssociationSet } = await import("./aspProof");
  const { readDepositInfo, classifyAspNote } = await import("./depositLabel");
  const infoByLabel = new Map<string, Awaited<ReturnType<typeof readDepositInfo>>>();
  const aspByLabel = new Map<string, boolean>();
  const privateNotes: CandidateNote[] = [];
  let heldTotal = 0n;
  for (const c of candidates) {
    const lab = String(c.data.label || "").trim();
    if (!lab || lab === "0") continue;
    if (!infoByLabel.has(lab)) infoByLabel.set(lab, await readDepositInfo(vaultForNullifier, lab));
    if (!aspByLabel.has(lab)) aspByLabel.set(lab, await labelInAssociationSet(lab));
    const info = infoByLabel.get(lab) ?? null;
    const inAsp = aspByLabel.get(lab) === true;
    const access = classifyAspNote(info?.status ?? -1, inAsp);
    if (access === "spent") continue;
    if (access === "deposited") privateNotes.push(c);
    else heldTotal += c.amountWei;
  }

  const totalPrivate = privateNotes.reduce((s, n) => s + n.amountWei, 0n);
  const selectedNotes: CandidateNote[] = [];
  let accumulated = 0n;
  const orderedPrivate = [...privateNotes].sort((a, b) =>
    a.amountWei > b.amountWei ? -1 : a.amountWei < b.amountWei ? 1 : 0,
  );
  for (const c of orderedPrivate) {
    if (accumulated >= withdrawnValueTotal) break;
    if (selectedNotes.length >= MAX_NOTES) break;
    selectedNotes.push(c);
    accumulated += c.amountWei;
  }
  // Greedy-boundary ordering: the change note inherits the BOUNDARY input's label and the circuit
  // requires the boundary at index N-1 with `changeValue <= inValue[N-1]`. The boundary is the SMALLEST
  // selected note — all larger notes fully exit the pool, only the smallest leaves a remainder. So order
  // selected notes DESCENDING by value → smallest lands at index N-1. (Replaces the ascending-by-label
  // ordering the removed composite CrossLabelOutLabel needed.)
  selectedNotes.sort((a, b) =>
    a.amountWei > b.amountWei ? -1 : a.amountWei < b.amountWei ? 1 : 0,
  );

  if (accumulated < withdrawnValueTotal) {
    // A quarantined note (on-chain but with secret material that doesn't reproduce its leaf) is
    // repairable from the authoritative precommitment row. Attempt the repair inline so the
    // withdraw self-heal's single retry re-reads a now-consistent note and succeeds — instead of
    // failing later with the cryptic in-circuit Merkle assert.
    if (_inconsistent.length > 0 && _zkSigner) {
      const { repairInconsistentOutputNote } = await import('./outputNoteResolver');
      let repaired = 0;
      for (const bad of _inconsistent) {
        try {
          const ok = await repairInconsistentOutputNote(_zkSigner, {
            precommitment: bad.precommitment,
            commitment:    bad.commitment,
            amountWei:     bad.amountWei,
            chainId:       _chainId,
            symbol:        _token.symbol,
            tokenAddress,
            decimals:      _token.decimals,
          });
          if (ok) repaired++;
        } catch (e) { console.warn('[withdraw] repair failed for', bad.key, e); }
      }
      if (repaired > 0) {
        return { error: `Repaired ${repaired} ${_token.symbol} note(s) whose saved secret was out of sync — retry the withdrawal now.` };
      }
      // Repair failed for the inconsistent note(s). But if there are OTHER notes that are merely
      // metadata-only (an unresolved vault-output whose encrypted secret is still in the pending
      // record), a SIGNED resolve can make them spendable — don't let one unrecoverable note block
      // a perfectly good one. Surface a retryable "out of sync" error so the withdraw self-heal runs
      // resolvePendingOutputNotes(signer) and retries; the unspendable note is simply skipped if the
      // resolved note covers the amount.
      if (diag.unreadable > 0) {
        return { error: `Resolving your ${_token.symbol} notes — out of sync, retry in a moment.` };
      }
      return { error: `A ${_token.symbol} note is on-chain but its saved secret can't be recovered from your backup — this note may be unspendable. (${diag.badsecret} affected)` };
    }
    if (diag.noSigner) {
      return { error: `Wallet not connected for note decryption — reconnect and retry.` };
    }
    if (diag.ok === 0 && (diag.unreadable > 0 || _drifted)) {
      if (hasPendingMergeFor(_token.symbol)) {
        return { error: `Consolidating your ${_token.symbol} notes — wait ~30 seconds for the merge to confirm, then retry.` };
      }
      // Only blame another account when EVERY unreadable note is that account's. Old notes from a
      // previously-connected wallet sit in the same localStorage namespace forever, so checking
      // `foreignOwners.size > 0` first told a user on the correct account to "connect 0x5830…"
      // while their OWN notes were the ones that would not decrypt — the real cause (key drift, or
      // an unresolved vault-output) was two branches further down and never reached.
      if (foreignOwners.size > 0 && unreadableOwn === 0) {
        const o = [...foreignOwners][0];
        return { error: `These notes belong to account ${o.slice(0, 6)}…${o.slice(-4)} — connect that account to withdraw.` };
      }
      if (_drifted) {
        return { error: `This wallet/device can't decrypt your Siphon notes — reconnect the exact account & device you deposited with, then retry.` };
      }
      return { error: `Found ${diag.unreadable} ${_token.symbol} note(s) but their secrets aren't on this device (metadata-only). Restore via Import Notes, or these funds came from a swap whose secret wasn't saved.` };
    }
    const totalStr = ethers.formatUnits(totalPrivate, _token.decimals);
    const heldStr = ethers.formatUnits(heldTotal, _token.decimals);
    if (heldTotal > 0n && totalPrivate < withdrawnValueTotal) {
      if (totalPrivate === 0n) {
        return { error: `Those ${_token.symbol} funds are still in checking (${heldStr}). Wait for screening — flagged deposits can be ragequit from Activity.` };
      }
      return { error: `Private withdraw can use ${totalStr} ${_token.symbol} (deposited / ASP-admitted). ${heldStr} is still in checking.` };
    }
    if (totalPrivate >= withdrawnValueTotal && selectedNotes.length >= MAX_NOTES) {
      return { error: `Withdrawal needs more than ${MAX_NOTES} notes — consolidate fragmented notes first, then retry.` };
    }
    if (totalPrivate > 0n && totalPrivate < withdrawnValueTotal) {
      return {
        error: `Insufficient admitted balance: have ${totalStr} ${_token.symbol}, need ${_amount}.`,
      };
    }
    return { error: `Insufficient balance. Have ${ethers.formatUnits(accumulated, _token.decimals)}, need ${_amount}.` };
  }

  const N = selectedNotes.length;
  console.log(`Selected ${N} note(s) totaling ${ethers.formatUnits(accumulated, _token.decimals)} ${_token.symbol}`);

  // 5. CLAIM CHANGE NOTE SECRETS FROM POOL
  // Secrets are claimed from the pre-generated pool in DB so they survive a tab-close
  // between proof generation and tx confirmation. Falls back to deterministic derivation
  // if no signer is available (shouldn't happen in practice).
  let changeNullifier: bigint, changeSecret: bigint, changePrecommitment: bigint;
  let changePoolId: string | null = null;
  if (signer) {
    try {
      const { claimFromPool } = await import('./sparePool');
      const inputNullifiers = new Set(selectedNotes.map(n => n.data.nullifier));
      const claimed = await claimFromPool(signer);
      changeNullifier     = BigInt(claimed.nullifier);
      changeSecret        = BigInt(claimed.secret);
      changePrecommitment = BigInt(claimed.precommitment);
      changePoolId        = claimed.id;
      // Circuit asserts changeNullifier ≠ every inputNullifier. A stale pool entry (not
      // resolved after a prior tx) can return a nullifier already used as an input, causing
      // the circuit to fail at line 95. Detect it and fall back to deterministic derivation.
      if (inputNullifiers.has(claimed.nullifier)) {
        console.warn('[generateZKData] pool returned a nullifier matching an input note — falling back to deterministic change secrets');
        const nullifierXor = selectedNotes.reduce((acc, n) => acc ^ BigInt(n.data.nullifier), 0n);
        changeNullifier     = BigInt(F.toObject(poseidon([nullifierXor, 1n])));
        changeSecret        = BigInt(F.toObject(poseidon([nullifierXor, 2n])));
        changePrecommitment = BigInt(F.toObject(poseidon([changeNullifier, changeSecret])));
        changePoolId        = null;
      }
    } catch (poolErr) {
      console.warn('[generateZKData] pool claim failed, using deterministic fallback:', poolErr);
      const nullifierXor  = selectedNotes.reduce((acc, n) => acc ^ BigInt(n.data.nullifier), 0n);
      changeNullifier     = BigInt(F.toObject(poseidon([nullifierXor, 1n])));
      changeSecret        = BigInt(F.toObject(poseidon([nullifierXor, 2n])));
      changePrecommitment = BigInt(F.toObject(poseidon([changeNullifier, changeSecret])));
      // changePoolId stays null — no pool entry to resolve
    }
  } else {
    const nullifierXor  = selectedNotes.reduce((acc, n) => acc ^ BigInt(n.data.nullifier), 0n);
    changeNullifier     = BigInt(F.toObject(poseidon([nullifierXor, 1n])));
    changeSecret        = BigInt(F.toObject(poseidon([nullifierXor, 2n])));
    changePrecommitment = BigInt(F.toObject(poseidon([changeNullifier, changeSecret])));
  }
  const changeValue = accumulated - withdrawnValueTotal;
  // Hard ASP: changeCommitment = Poseidon(Poseidon(changeValue, changeLabel), precommitment)
  const inLabels = selectedNotes.map((n) => String(n.data.label || "").trim());
  if (inLabels.some((l) => !l || l === "0")) {
    return { error: "selected note(s) missing Hard ASP label — cannot withdraw" };
  }
  const { loadAspWitness } = await import("./aspProof");
  const { hashCommitment } = await import("./noteCrypto");
  // Greedy-boundary: the change inherits the BOUNDARY (smallest, index N-1) note's real admitted label.
  // No composite derivation. The circuit enforces `changeValue <= inValue[N-1]`; this holds by
  // construction (largest-first greedy fill → the last/smallest note carries the whole remainder), but
  // assert it so a selection bug fails loudly here instead of as an opaque in-circuit revert.
  const boundaryNote = selectedNotes[selectedNotes.length - 1];
  if (changeValue > boundaryNote.amountWei) {
    return { error: "internal: change exceeds boundary note value — note selection invariant violated" };
  }
  const changeLabel = inLabels[inLabels.length - 1];
  const aspW = await loadAspWitness(inLabels);
  if ("error" in aspW) return { error: aspW.error };

  const changeCommitmentBig = await hashCommitment(
    changeValue,
    BigInt(changeLabel),
    changePrecommitment,
  );

  // 6. BUILD MERKLE PATHS FOR EACH INPUT NOTE (one tree build, O(depth) per note).
  // stateRoot is already bound to this leaf snapshot via merkleSnapshotForProof.
  const pathElementsAll: bigint[][] = [];
  const pathIndicesAll: number[][] = [];
  for (const note of selectedNotes) {
    const { pathElements, pathIndices } = tree.path(note.leafIndex);
    const folded = tree.fold(tree.leafAt(note.leafIndex), { pathElements, pathIndices }, poseidonHash);
    if (folded !== stateRoot) {
      return { error: 'Merkle path does not fold to snapshot root — refresh and retry in a moment.' };
    }
    pathElementsAll.push(pathElements);
    pathIndicesAll.push(pathIndices);
  }

  // 7. ASSEMBLE CIRCUIT INPUT AND GENERATE PROOF
  // Hard ASP Withdrawal(32, N) publics: withdrawnValue, stateRoot, aspRoot, changeCommitment,
  // changeLabel, nullifierHash[N], recipient
  const nullifierHashesInput = selectedNotes.map(n =>
    BigInt(F.toObject(poseidon([BigInt(n.data.nullifier)]))).toString()
  );

  const circuitInput: Record<string, unknown> = {
    withdrawnValue:   withdrawnValueTotal.toString(),
    stateRoot:        stateRoot.toString(),
    aspRoot:          aspW.aspRoot,
    changeCommitment: changeCommitmentBig.toString(),
    changeLabel,
    nullifierHash:    nullifierHashesInput,
    recipient:        BigInt(_recipient).toString(),
    changeNullifier:  changeNullifier.toString(),
    changeSecret:     changeSecret.toString(),
    inValue:          selectedNotes.map(n => n.amountWei.toString()),
    inNullifier:      selectedNotes.map(n => n.data.nullifier.toString()),
    inSecret:         selectedNotes.map(n => n.data.secret.toString()),
    inLabel:          inLabels,
    pathElements:    pathElementsAll.map(pe => pe.map(v => v.toString())),
    pathIndices:     pathIndicesAll.map(pi => pi.map(String)),
    aspPathElements: aspW.aspPathElements,
    aspPathIndices:  aspW.aspPathIndices,
  };

  // DIAGNOSTIC: Hard ASP leaf = Poseidon(Poseidon(amount, label), precommitment)
  try {
    for (let i = 0; i < selectedNotes.length; i++) {
      const n = selectedNotes[i];
      const inPre = BigInt(F.toObject(poseidon([BigInt(n.data.nullifier), BigInt(n.data.secret)])));
      const inner = BigInt(F.toObject(poseidon([n.amountWei, BigInt(inLabels[i])])));
      const inLeaf = BigInt(F.toObject(poseidon([inner, inPre])));
      let cur = inLeaf;
      const pe = pathElementsAll[i], pi = pathIndicesAll[i];
      for (let l = 0; l < pe.length; l++) {
        cur = pi[l] === 0 ? poseidonHash(cur, pe[l]) : poseidonHash(pe[l], cur);
      }
      if (ZK_DEBUG) {
        console.log('[withdraw-diag] merkle path check', {
          note: n.key,
          leafIndex: n.leafIndex,
          inLeafMatchesTreeLeaf: inLeaf === leaves[n.leafIndex],
          foldedRootMatchesStateRoot: cur === stateRoot,
        });
      }
    }
  } catch (e) { console.warn('[withdraw-diag] merkle path check failed', e); }

  console.log("[Proof] Generating Groth16 W" + N + " proof locally (snarkjs)…");
  const result = await prepareWithdrawalTransactionMulti(circuitInput, N);
  const { proof: rawProof, publicSignals } = result;

  // Hard ASP: [withdrawnValue, stateRoot, aspRoot, changeCommitment, changeLabel, nullifierHash[0..N-1], recipient]
  const changeCommitmentOnChain = BigInt(publicSignals[3]);
  const changeLabelOnChain = publicSignals[4];
  const nullifierHashes: string[] = selectedNotes.map((_, i) => publicSignals[5 + i]);

  const withdrawalTxData: WithdrawalTxData = {
    recipient:        _recipient,
    amount:           withdrawnValueTotal.toString(),
    nullifierHashes,
    nullifierHash:    nullifierHashes[0],
    changeCommitment: changeCommitmentOnChain.toString(),
    changeLabel:      changeLabelOnChain,
    aspRoot:          aspW.aspRoot,
    newCommitment:    changeCommitmentOnChain.toString(),
    stateRoot:        stateRoot.toString(),
    changeValue:      changeValue.toString(),
    pA:               rawProof.pA as [string, string],
    pB:               rawProof.pB as [[string, string], [string, string]],
    pC:               rawProof.pC as [string, string],
    publicSignals,
  };

  // 8. VALIDATE PROOF FORMAT
  if (!Array.isArray(withdrawalTxData.pA) || withdrawalTxData.pA.length !== 2 ||
      !Array.isArray(withdrawalTxData.pB) || withdrawalTxData.pB.length !== 2 ||
      !Array.isArray(withdrawalTxData.pC) || withdrawalTxData.pC.length !== 2) {
    return { error: "Proof has invalid Groth16 format" };
  }

  // 9. PACKAGE ZK DATA
  const changeNullifierHash = BigInt(F.toObject(poseidon([changeNullifier]))).toString();

  const zkData: ZKData = {
    withdrawalTxData,
    changeValue,
    newDepositKey: (await import('./localNoteStore')).noteKey(_chainId, _token.symbol, changeCommitmentOnChain.toString()),
    newDeposit: {
      secret:        changeSecret.toString(),
      nullifier:     changeNullifier.toString(),
      precommitment: changePrecommitment.toString(),
      commitment:    changeCommitmentOnChain.toString(),
      label:         changeLabelOnChain,
      nullifierHash: changeNullifierHash,
      amount:        ethers.formatUnits(changeValue, _token.decimals),
    },
    spentDepositKeys: selectedNotes.map(n => n.key),
    spentDeposits:    selectedNotes.map(n => n.data),
    spentDepositKey:  selectedNotes[0].key,
    spentDeposit:     selectedNotes[0].data,
    changePoolId,
    serverCommitmentIds,
  };

  return zkData;
}

export type RagequitProofOptions = {
  /** Allow change notes (ragequitBatch). Single `ragequit` still requires the original deposit. */
  allowChangeNotes?: boolean;
};

/**
 * Ragequit: exit a Pending/Revoked deposit without ASP inclusion.
 * Proves note ownership; Vault pays original depositor.
 * Single `ragequit` finalizes the label; `ragequitBatch` spends per-note nullifiers only.
 */
export async function generateRagequitProof(
  _chainId: number,
  _token: TokenInfo,
  _noteKey: string,
  opts?: RagequitProofOptions,
): Promise<
  | {
      asset: string;
      label: string;
      stateRoot: string;
      nullifierHash: string;
      amount: string;
      amountWei: string;
      commitment: string;
      pA: string[];
      pB: string[][];
      pC: string[];
      spentDepositKey: string;
    }
  | { error: string }
> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const pHash = (a: bigint, b: bigint): bigint => BigInt(F.toObject(poseidon([a, b])));
  const pHash1 = (a: bigint): bigint => BigInt(F.toObject(poseidon([a])));

  const signer = getSigner();
  if (!signer) return { error: "Wallet not connected." };
  const depositor = await signer.getAddress();

  const tokenAddress = _token.symbol === "ETH" ? NATIVE_TOKEN : _token.address;
  let leaves: bigint[];
  try {
    leaves = await getOnChainLeaves(tokenAddress, _chainId);
  } catch {
    return { error: "Failed to fetch on-chain leaves for ragequit." };
  }

  const { vault, merkleTreeAddress } = await resolveVault(tokenAddress, _chainId);
  const provider = getReadProvider(_chainId);
  const merkleTreeContract = new Contract(
    merkleTreeAddress,
    merkleTreeAbiJson.abi as ethers.InterfaceAbi,
    provider,
  );

  let tree: MerkleTreeView;
  let stateRoot: bigint;
  try {
    ({ tree, stateRoot } = await merkleSnapshotForProof(leaves, pHash, merkleTreeContract));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Merkle snapshot unusable for ragequit: ${msg}` };
  }

  const { readNote } = await import("./localNoteStore");
  const data = await readNote(_noteKey, signer);
  if (!data?.nullifier || !data.secret || !data.commitment) {
    return { error: "Cannot decrypt ragequit note on this device." };
  }
  const label = String(data.label || "").trim();
  if (!label || label === "0") return { error: "ragequit note missing Hard ASP label" };

  const amountWei = BigInt(ethers.parseUnits(data.amount.toString(), _token.decimals).toString());
  const leafIndex = leaves.findIndex((l) => l === BigInt(data.commitment));
  if (leafIndex === -1) return { error: "Ragequit note not found in state tree." };
  if (tree.leafAt(leafIndex) !== BigInt(data.commitment)) {
    return { error: "Ragequit leaf integrity check failed." };
  }

  const nBig = safeBigInt(data.nullifier);
  const sBig = safeBigInt(data.secret);
  if (nBig === null || sBig === null || nBig === 0n || sBig === 0n) {
    return { error: "Ragequit note secret material is corrupt — restore notes and retry." };
  }
  try {
    const { leaf } = await reconstructLeaf(nBig, sBig, amountWei, BigInt(label));
    if (leaf !== BigInt(data.commitment) || leaf !== tree.leafAt(leafIndex)) {
      return { error: "Ragequit note does not reproduce its on-chain leaf." };
    }
  } catch {
    return { error: "Ragequit note failed leaf reconstruction." };
  }

  const nullifierHash = pHash1(BigInt(data.nullifier));
  if (await withRetry(() => vault.nullifiers(nullifierHash))) {
    return { error: "These funds were already returned to the depositing wallet." };
  }

  const { readDepositInfo, isOriginalDepositNote, LABEL_PENDING, LABEL_REVOKED, LABEL_RAGEQUIT } = await import("./depositLabel");
  const info = await readDepositInfo(vault, label);
  if (!info) {
    return { error: "No original deposit for this label — change notes cannot be ragequit." };
  }
  if (info.depositor.toLowerCase() !== depositor.toLowerCase()) {
    return { error: "Connect the original depositing wallet to ragequit." };
  }
  if (!opts?.allowChangeNotes) {
    if (!isOriginalDepositNote(data.commitment, info)) {
      return { error: "This is a change note, not the original deposit — ragequit is only for the original note." };
    }
    if (info.amount !== amountWei) {
      return { error: "Note amount does not match the original deposit — cannot ragequit." };
    }
  }
  if (info.status === LABEL_RAGEQUIT) {
    return { error: "These funds were already returned to the depositing wallet." };
  }
  if (info.status !== LABEL_PENDING && info.status !== LABEL_REVOKED) {
    return {
      error:
        info.status === 1
          ? "Label is Admitted — use private withdraw instead of ragequit"
          : "Label is not Pending/Revoked — ragequit not allowed",
    };
  }

  const { pathElements, pathIndices } = tree.path(leafIndex);
  const circuitInput = {
    stateRoot: stateRoot.toString(),
    nullifierHash: nullifierHash.toString(),
    label,
    amount: amountWei.toString(),
    depositor: BigInt(depositor).toString(),
    commitment: BigInt(data.commitment).toString(),
    inNullifier: BigInt(data.nullifier).toString(),
    inSecret: BigInt(data.secret).toString(),
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
  };

  const { prepareRagequitTransaction } = await import("./generateProof");
  const { proof } = await prepareRagequitTransaction(circuitInput);

  return {
    asset: tokenAddress,
    label,
    stateRoot: stateRoot.toString(),
    nullifierHash: nullifierHash.toString(),
    amount: data.amount.toString(),
    amountWei: amountWei.toString(),
    commitment: BigInt(data.commitment).toString(),
    pA: proof.pA,
    pB: proof.pB,
    pC: proof.pC,
    spentDepositKey: _noteKey,
  };
}

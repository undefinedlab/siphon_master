/**
 * Resolve the notes a v3 strategy leg MINTS when its trigger fires.
 *
 * A strategy leg re-shields its swap proceeds into a note owned by `outputPrecommitment`. Nobody
 * can write that note at arming time, because it does not exist yet — the kernel mints it on-chain
 * at fill. So arming records two things and neither is a spendable note:
 *
 *   - a precommitment row on the server (cross-device backup of {nullifier, secret}), and
 *   - the stash below: the full note, encrypted, under a key `loadV3Notes` deliberately cannot see.
 *
 * After the fill this promotes the stash into a real note. Until then the funds are on-chain and
 * fully owned but invisible in the UI — which is exactly the bug this file exists to close: the
 * first successful attested fill on Sepolia (tx 0x294c1a0e…) minted 2.486642 USDC that the
 * dashboard could not show, because `getV3Balance` reads local notes and arming never wrote one.
 *
 * WHY A SEPARATE KEYSPACE, not a flag on the note:
 * `loadV3Notes` skips only `spent === "true"`, so anything written under the real note prefix is
 * immediately spendable — a strategy that has not fired yet would show a phantom balance and could
 * be selected for a spend against a leaf that does not exist. Overloading `spent: "pending"` was
 * the other option and it is worse: that value already means "a spend is in flight", and a
 * resolver promoting those would un-pend an in-flight spend into a double-spend attempt. A stash
 * the note loader cannot see makes the hazard structurally impossible instead of conditionally
 * avoided.
 */
import type { Signer } from "ethers";

import { decryptBlob, deriveEncKey, encryptBlob } from "../noteAuth";
import { v3Config, v3Deployed } from "./configV3";
import { saveV3Note } from "./noteStoreV3";
import { recordSwapOnCursor } from "./noteCursorSession";
import { fetchStateLeaves } from "./stateLeavesClient";

const PENDING_PREFIX = "siphon-v3pending-";

/** Mirrors `v3NoteKey`'s scheme so the two never collide and both stay greppable. */
function pendingKey(chainId: number, symbol: string, commitment: string): string {
  return `${PENDING_PREFIX}${chainId}-${symbol.toUpperCase()}-${commitment}`;
}

/** The note a leg will mint, as the arm knows it before the trigger fires. */
export interface PendingOutputNote {
  nullifier: string;
  secret: string;
  label: string;
  /** uint160(token) of the OUTPUT asset. */
  assetId: string;
  /** Uppercased output symbol — the storage key and Supabase `asset` column. */
  symbol: string;
  /** Public limb 22: the exact commitment the circuit constrains and the kernel inserts. */
  commitment: string;
  /** `minAmountOut`. The kernel mints the user note at EXACTLY minOut (VaultKernel: any surplus
   *  over it accrues to the protocol), so this is known before the trade happens. */
  value: string;
  precommitment: string;
}

interface PendingRow {
  enc_blob: string;
  iv: string;
  commitment: string;
  symbol: string;
  chainId: number;
  vaultId: string;
  createdAt: number;
}

/**
 * Record the note a leg will mint. Encrypted with the same key as a real note — this holds
 * spendable secrets, and localStorage is not a safe place for them in the clear.
 */
export async function stashPendingOutputNote(
  chainId: number,
  note: PendingOutputNote,
  signer: Signer,
): Promise<void> {
  if (typeof localStorage === "undefined") return;
  const cfg = v3Config(chainId);
  const encKey = await deriveEncKey(signer);
  const { enc_blob, iv } = await encryptBlob(encKey, {
    nullifier: note.nullifier,
    secret: note.secret,
    label: note.label,
    assetId: note.assetId,
    value: note.value,
    precommitment: note.precommitment,
  });

  const row: PendingRow = {
    enc_blob,
    iv,
    commitment: note.commitment,
    symbol: note.symbol.toUpperCase(),
    chainId,
    // Scoped to the kernel for the same reason notes are: after a cutover the retired
    // generation's stashes sit in this keyspace and their leaves are in a tree this kernel
    // has never seen, so they would never resolve and would be retried forever.
    vaultId: cfg?.vaultKernel ? `v3-${cfg.vaultKernel}` : `v3-${chainId}`,
    createdAt: Date.now(),
  };
  localStorage.setItem(pendingKey(chainId, note.symbol, note.commitment), JSON.stringify(row));
}

/**
 * Promote every stashed output note whose leaf is now in the state tree.
 *
 * Returns how many were resolved. Safe to call on every dashboard refresh: it returns early
 * without touching the network when there is nothing staged, and `saveV3Note` is idempotent on
 * the note key, so a double call cannot duplicate a note.
 */
export async function resolveV3OutputNotes(chainId: number, signer: Signer): Promise<number> {
  if (!v3Deployed(chainId)) return 0;
  if (typeof localStorage === "undefined") return 0;

  const cfg = v3Config(chainId);
  const activeVaultId = cfg?.vaultKernel ? `v3-${cfg.vaultKernel}` : `v3-${chainId}`;
  const prefix = `${PENDING_PREFIX}${chainId}-`;

  const staged: Array<{ key: string; row: PendingRow }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    try {
      const row = JSON.parse(localStorage.getItem(k) || "") as PendingRow;
      if (!row?.enc_blob || !row.iv || !row.commitment) continue;
      if (row.vaultId && row.vaultId !== activeVaultId) continue;
      staged.push({ key: k, row });
    } catch {
      /* a corrupt stash must not stop the others */
    }
  }
  // The common case by far. Do not spend an indexer round trip per refresh to learn it.
  if (staged.length === 0) return 0;

  const leavesResult = await fetchStateLeaves(chainId);
  if (!leavesResult.available || !leavesResult.data) {
    console.warn(
      `[v3-output] state leaves unavailable (${leavesResult.reason ?? "unknown"}) — ` +
        `${staged.length} staged note(s) stay staged`,
    );
    return 0;
  }
  const onChain = new Set(leavesResult.data.leaves.map((l) => l.toString()));

  const encKey = await deriveEncKey(signer);
  let resolved = 0;

  for (const { key, row } of staged) {
    // Not minted yet: the trigger has not fired, or the fill has not been indexed. Leave it.
    if (!onChain.has(String(row.commitment))) continue;

    try {
      const d = await decryptBlob<{
        nullifier: string;
        secret: string;
        label: string;
        assetId: string;
        value: string;
        precommitment: string;
      }>(encKey, row.enc_blob, row.iv);

      await saveV3Note(
        chainId,
        {
          nullifier: d.nullifier,
          secret: d.secret,
          label: d.label,
          assetId: d.assetId,
          symbol: row.symbol,
          commitment: String(row.commitment),
          value: d.value,
          precommitment: d.precommitment,
          origin: "change",
        },
        signer,
        "vault-output",
      );

      // Cursor follows the swap output on this vault when a run is active here (fail-open).
      recordSwapOnCursor({
        chainId,
        symbol: row.symbol,
        commitment: String(row.commitment),
        value: d.value,
      });

      // Only after the note is durable. Losing the stash before saveV3Note lands would strand the
      // secrets for a note that exists on-chain, which is the failure this whole file prevents.
      localStorage.removeItem(key);
      resolved += 1;
      console.log(`[v3-output] resolved ${row.symbol} note ${String(row.commitment).slice(0, 18)}…`);
    } catch (e) {
      console.warn(`[v3-output] could not resolve staged note ${key}:`, e);
    }
  }

  return resolved;
}

/**
 * Recover an output note that was armed BEFORE this file existed, so has no stash.
 *
 * Everything needed is still recoverable: the {nullifier, secret} live in the server-side
 * precommitment row (encrypted under the user's own key, so only their browser can open it), the
 * amount and asset are readable from the fill's `SwapUserDestNote(token, minOut, commitment)`
 * event, and the label — the one field nothing records — is INHERITED from the note the leg spent,
 * so it can be recovered by trying the labels of the user's own notes and keeping the one whose
 * commitment is actually in the tree.
 *
 * Deliberately verifies against the on-chain leaf set rather than trusting the arithmetic. A label
 * that hashes to a commitment no leaf contains is the wrong label, and saving it would create a
 * note that displays a balance and then fails every spend at the circuit's Merkle assert.
 *
 * Returns the recovered commitment, or null if no candidate matched.
 */
export async function adoptOrphanOutputNote(
  chainId: number,
  signer: Signer,
  spec: {
    /** From the fill's SwapUserDestNote event. */
    valueWei: string;
    /** uint160(token) of the output asset. */
    assetId: string;
    /** Uppercased output symbol, e.g. "USDC". */
    symbol: string;
    /** Optional: skip the label search when it is already known. */
    label?: string;
  },
): Promise<string | null> {
  const { fetchPendingPrecommitments } = await import("../precommitmentStore");
  const { hashCommitmentWithPre } = await import("./noteCryptoV3");
  const { loadV3Notes } = await import("./noteStoreV3");

  const leavesResult = await fetchStateLeaves(chainId);
  if (!leavesResult.available || !leavesResult.data) {
    throw new Error(`adoptOrphanOutputNote: state leaves unavailable (${leavesResult.reason ?? "unknown"})`);
  }
  const onChain = new Set(leavesResult.data.leaves.map((l) => l.toString()));

  const pending = await fetchPendingPrecommitments(signer);
  if (pending.length === 0) return null;

  // Candidate labels: every label the user's own notes carry. The spent input note may already be
  // marked spent and dropped from loadV3Notes, so include the ones still present AND any label
  // seen on a staged note — in practice a user has a handful, so this search is trivial.
  const candidates = new Set<string>(spec.label ? [spec.label] : []);
  if (!spec.label) {
    for (const n of await loadV3Notes(chainId, signer)) candidates.add(n.label);
  }
  if (candidates.size === 0) {
    throw new Error("adoptOrphanOutputNote: no candidate labels — pass `label` explicitly");
  }

  const value = BigInt(spec.valueWei);
  const assetId = BigInt(spec.assetId);

  for (const p of pending) {
    const pre = String(p.decrypted?.precommitment ?? "");
    if (!pre) continue;
    for (const label of candidates) {
      const commitment = (await hashCommitmentWithPre(value, BigInt(label), assetId, BigInt(pre))).toString();
      if (!onChain.has(commitment)) continue;

      await saveV3Note(
        chainId,
        {
          nullifier: String(p.decrypted.nullifier),
          secret: String(p.decrypted.secret),
          label,
          assetId: spec.assetId,
          symbol: spec.symbol.toUpperCase(),
          commitment,
          value: value.toString(),
          precommitment: pre,
          origin: "change",
        },
        signer,
        "vault-output",
      );
      console.log(`[v3-output] adopted orphan ${spec.symbol} note ${commitment.slice(0, 18)}…`);
      return commitment;
    }
  }

  return null;
}

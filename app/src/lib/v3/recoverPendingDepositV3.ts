/**
 * Recover a deposit whose note was never durably written.
 *
 * THE HOLE THIS FILLS. `depositV3` stashes the note secrets to localStorage *before* sending the
 * transaction, precisely because the dangerous window is "deposit mined, note not yet saved" — a
 * crash, a closed tab, or a throw between `tx.wait()` and `saveV3Note` leaves funds in the vault
 * with no spendable record. The stash was written for exactly that case and cleared on success.
 *
 * Nothing ever read it back. The recovery half was never built, so the stash sat in localStorage
 * doing nothing while the note it protected stayed unrecoverable without hand-editing storage.
 *
 * WHY THE CHAIN IS THE AUTHORITY HERE. The stash cannot contain the note: `label` is derived from
 * `depositNonce`, which is assigned by the vault at mint time and only exists on-chain. So recovery
 * is not "replay the stash" — it is "find the Deposited event this stash belongs to, and rebuild
 * the note from the event". A stash with no matching event is a deposit that never landed (the tx
 * reverted, or was never sent), and it must be discarded rather than turned into a phantom note.
 *
 * SAFE TO RUN REPEATEDLY. Every step is idempotent: an already-saved note is detected and the stash
 * simply cleared, and `saveV3Note` overwrites by commitment rather than duplicating.
 */

import { Contract, type Signer } from "ethers";

import { deriveDepositLabel, assetIdFromToken, hashPrecommitment, hashCommitment } from "./noteCryptoV3";
import { v3Config } from "./configV3";
import { saveV3Note } from "./noteStoreV3";
import { assetSymbolForToken } from "../leafIndexClient";

const STASH_PREFIX = "v3-pending-deposit:";

/** How far back to scan for the Deposited event. A stash older than this is stale beyond recovery. */
const MAX_LOOKBACK_BLOCKS = 50_000;

export interface StashedDeposit {
  nullifier: string;
  secret: string;
  userSalt: string;
  token: string;
  amount: string;
  vaultKernel: string;
  chainId: number;
  ts?: number;
}

export interface RecoveryResult {
  /** Notes rebuilt from an on-chain Deposited event and durably saved. */
  recovered: number;
  /** Stashes whose note already existed — cleared, nothing to do. */
  alreadyPresent: number;
  /** Stashes with no matching on-chain deposit (reverted / never sent) — cleared. */
  noDeposit: number;
  /** Stashes left in place because the chain could not be reached; safe to retry later. */
  deferred: number;
}

// MUST match depositV3's ABI exactly, `indexed` flags included: a wrong flag silently fails to
// decode, and a recovery that cannot see its own deposit is worse than no recovery at all.
const DEPOSITED_ABI = [
  "event Deposited(address depositor, address indexed token, uint256 amount, uint256 commitment, uint256 depositNonce, uint256 stateRootAfter)",
];

function readStashes(chainId: number): Array<{ key: string; value: StashedDeposit }> {
  if (typeof localStorage === "undefined") return [];
  const out: Array<{ key: string; value: StashedDeposit }> = [];
  const prefix = `${STASH_PREFIX}${chainId}:`;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k) || "{}") as StashedDeposit;
      if (v?.nullifier && v.secret && v.userSalt) out.push({ key: k, value: v });
    } catch {
      // A corrupt stash is not recoverable and re-parsing it every load is noise. Leave it: the
      // cost is one dead localStorage key, and deleting something we cannot read is worse.
    }
  }
  return out;
}

function noteExists(chainId: number, commitment: string): boolean {
  if (typeof localStorage === "undefined") return false;
  const suffix = `-${commitment}`;
  const prefix = `siphon-v3note-${chainId}-`;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix) && k.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Rebuild any deposit that mined but whose note was never saved.
 *
 * @param chainId  chain to scan; stashes are keyed per chain.
 * @param signer   must be the SAME wallet that made the deposit — the note is encrypted under its
 *                 enc-key, and a different wallet would write a note it cannot later read.
 * @returns counts per outcome. Never throws for a single bad stash: one unrecoverable entry must
 *          not block the others, since each is a separate deposit of real funds.
 */
export async function recoverPendingDeposits(
  chainId: number,
  signer: Signer,
): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: 0, alreadyPresent: 0, noDeposit: 0, deferred: 0 };
  const stashes = readStashes(chainId);
  if (stashes.length === 0) return result;

  const cfg = v3Config(chainId);
  if (!cfg?.vaultKernel) {
    // Cannot verify anything against the chain — leave every stash untouched.
    result.deferred = stashes.length;
    return result;
  }

  const provider = signer.provider;
  if (!provider) {
    result.deferred = stashes.length;
    return result;
  }

  let tip: number;
  try {
    tip = await provider.getBlockNumber();
  } catch {
    result.deferred = stashes.length;
    return result;
  }

  const kernel = new Contract(cfg.vaultKernel, DEPOSITED_ABI, provider);

  for (const { key, value } of stashes) {
    try {
      // The stash belongs to THIS kernel or it is from a previous deployment. Reconstructing it
      // against the current kernel would mint a note whose leaf is in a tree this kernel does not
      // have — unspendable, and indistinguishable from a real note until proving time.
      if (value.vaultKernel && value.vaultKernel.toLowerCase() !== cfg.vaultKernel.toLowerCase()) {
        result.noDeposit++;
        localStorage.removeItem(key);
        continue;
      }

      const precommitment = await hashPrecommitment(
        BigInt(value.nullifier),
        BigInt(value.secret),
      );
      const assetId = assetIdFromToken(value.token);

      // CHUNKED. A single queryFilter over MAX_LOOKBACK_BLOCKS is rejected outright by most
      // endpoints ("range 50000 exceeds limit of 10000"), and because this runs on the balance
      // path it retried on every refresh and buried the console — while never recovering anything.
      // 9k matches the span stateLeavesClient already uses, safely under the common 10k cap.
      //
      // NEWEST FIRST: a stash is minutes old, so its deposit is near the tip. Scanning backwards
      // finds it in the first window instead of replaying the whole lookback every time.
      const SPAN = 9_000;
      const floor = Math.max(0, tip - MAX_LOOKBACK_BLOCKS);
      const events: Awaited<ReturnType<typeof kernel.queryFilter>> = [];
      for (let to = tip; to >= floor; to -= SPAN) {
        const from = Math.max(floor, to - SPAN + 1);
        events.push(...(await kernel.queryFilter(kernel.filters.Deposited(), from, to)));
        if (events.length > 0) break; // a hit this close to the tip is the stash's own deposit
        if (from === floor) break;
      }

      // The event carries NO precommitment, so the join is the commitment itself: for each
      // candidate, derive the label from that event's depositNonce and rebuild the commitment from
      // the stashed secrets. A match proves the stash, the label and the leaf all agree — which is
      // a stronger check than matching an id, because a match that verifies cannot be a wrong note.
      let match: (typeof events)[number] | undefined;
      let matchedLabel: bigint | undefined;
      for (const e of events) {
        const a = (e as unknown as {
          args?: { amount: bigint; commitment: bigint; depositNonce: bigint };
        }).args;
        if (!a) continue;
        const label = await deriveDepositLabel({
          chainId,
          vaultAddress: cfg.vaultKernel,
          depositNonce: a.depositNonce,
          userSalt: BigInt(value.userSalt),
        });
        const rebuilt = await hashCommitment(
          BigInt(a.amount),
          label,
          assetId,
          BigInt(value.nullifier),
          BigInt(value.secret),
        );
        if (rebuilt === BigInt(a.commitment)) {
          match = e;
          matchedLabel = label;
          break;
        }
      }

      if (!match) {
        // No deposit ever landed for these secrets: the tx reverted, was dropped, or was never
        // sent. Nothing is at risk — the funds never left the wallet — so drop the stash rather
        // than leave a permanent entry that re-scans on every load.
        result.noDeposit++;
        localStorage.removeItem(key);
        continue;
      }

      const args = (match as unknown as {
        args: { amount: bigint; depositNonce: bigint; commitment: bigint; token: string };
      }).args;

      if (noteExists(chainId, args.commitment.toString())) {
        result.alreadyPresent++;
        localStorage.removeItem(key);
        continue;
      }

      let depositTimestamp: number | undefined;
      try {
        const block = await provider.getBlock(match.blockNumber);
        if (block?.timestamp) depositTimestamp = Number(block.timestamp);
      } catch {
        /* display only */
      }

      await saveV3Note(
        chainId,
        {
          nullifier: value.nullifier,
          secret: value.secret,
          label: matchedLabel!.toString(),
          assetId: assetId.toString(),
          symbol: assetSymbolForToken(value.token, chainId) ?? value.token,
          commitment: args.commitment.toString(),
          // The MEASURED amount from the event, never the requested one — a fee-on-transfer or
          // rebasing token credits less than was asked for, and the note must match the leaf.
          value: args.amount,
          precommitment: precommitment.toString(),
          depositTxHash: match.transactionHash,
          userSalt: value.userSalt,
          depositTimestamp,
          origin: "deposit",
          spent: "false",
        },
        signer,
        "deposit",
      );

      localStorage.removeItem(key);
      result.recovered++;
    } catch {
      // Chain unreachable mid-scan, or a transient failure. Leave the stash: retrying later is
      // free, and clearing one we could not verify would destroy the only copy of the secrets.
      result.deferred++;
    }
  }

  return result;
}

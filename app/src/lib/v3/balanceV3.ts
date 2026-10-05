/**
 * v3 balance display helper (Task 5).
 *
 * Reads spendable v3 notes via loadV3Notes, classifies them via classifyNotesV3,
 * and formats the bucket totals into per-symbol figures for UserDash.
 */

import { Signer, ethers } from "ethers";
import { getTokens } from "../networks";
import { requireV3 } from "./configV3";
import { noteAssetIdFor } from "./noteCryptoV3";
import { classifyNotesV3, type LabeledNote } from "./noteStatusV3";
import { loadV3Notes } from "./noteStoreV3";

export interface V3BalanceDisplay {
  deposited: Record<string, number>;
  checking: Record<string, number>;
  flagged: Record<string, number>;
  unknown: Record<string, number>;
  ts: number;
}

export async function getV3Balance(
  chainId: number,
  signer: Signer,
  screenToken: string = "",
): Promise<V3BalanceDisplay> {
  const cfg = requireV3(chainId);

  const tokens = getTokens(chainId);

  // Load EVERY note for the chain, not one prefix per displayed symbol.
  //
  // Notes are keyed `siphon-v3note-{chainId}-{SYMBOL}-{commitment}`, where SYMBOL comes from the
  // note's ASSET. A native ETH deposit mints a WETH-denominated note, and WETH is not in
  // getTokens(), so assetSymbolForToken() returned null and the note was filed under its raw
  // address — while this loop only ever asked for "ETH" and "USDC". The deposit was on-chain and
  // invisible, which reads as lost funds.
  //
  // The symbol filter was never load-bearing: bucketing below is by assetId. Dropping it is both
  // the fix and the recovery path for notes already filed under a non-displayed symbol.
  const rawNotes = await loadV3Notes(chainId, signer);
  const notesBySymbol: LabeledNote[] = rawNotes.map((note) => ({
    label: note.label,
    value: note.value,
    assetId: note.assetId,
  }));

  // Classify against the chain's ASP service — an empty aspUrl would fail every membership lookup
  // and mis-classify all notes as UNKNOWN (zero spendable), so resolve it from trusted config.
  const buckets = await classifyNotesV3(cfg.aspUrl, screenToken, notesBySymbol, chainId);

  const deposited: Record<string, number> = {};
  const checking: Record<string, number> = {};
  const flagged: Record<string, number> = {};
  const unknown: Record<string, number> = {};

  for (const [symbol, cfg] of Object.entries(tokens)) {
    try {
      // Resolve through the note asset: an ETH deposit is wrapped, so its note carries WETH's
      // assetId. Deriving from the displayed 0xEeee… sentinel here would look up an assetId no
      // note ever has, and the balance would read zero while the funds sat in the vault.
      const assetId = noteAssetIdFor(chainId, cfg.address).toString();
      const decimals = cfg.decimals;

      const pWei = buckets.privateByAsset[assetId] ?? 0n;
      const cWei = buckets.inReviewByAsset[assetId] ?? 0n;
      const fWei = buckets.flaggedByAsset[assetId] ?? 0n;
      const uWei = buckets.unknownByAsset[assetId] ?? 0n;

      if (pWei > 0n) deposited[symbol] = parseFloat(ethers.formatUnits(pWei, decimals));
      if (cWei > 0n) checking[symbol] = parseFloat(ethers.formatUnits(cWei, decimals));
      if (fWei > 0n) flagged[symbol] = parseFloat(ethers.formatUnits(fWei, decimals));
      if (uWei > 0n) unknown[symbol] = parseFloat(ethers.formatUnits(uWei, decimals));
    } catch {
      /* ignore symbol if assetIdFromToken fails */
    }
  }

  return {
    deposited,
    checking,
    flagged,
    unknown,
    ts: Date.now(),
  };
}

/**
 * Output-note lifecycle for "vault-mode" swaps (swap output is re-deposited into the Siphon
 * vault as a private note the user owns, instead of being sent to an external address).
 *
 * Flow:
 *  1. createVaultOutputNote() — at strategy creation, generate the note's secret material and
 *     stash a PENDING record locally. Only the `precommitment` is shared with the executor.
 *  2. The executor swaps + re-deposits, and the vault emits Deposited(amount, commitment,
 *     precommitment). The amount/commitment are unknown until then (slippage).
 *  3. resolvePendingOutputNotes() — read the Deposited event for our precommitment, learn the
 *     real amount + commitment, write a spendable localStorage note, and (best-effort) sync it
 *     to the server encrypted. The normal withdraw flow then discovers and spends it.
 *
 * The nullifier/secret never leave the browser in plaintext — the server copy is AES-encrypted
 * with a wallet-derived key (see noteStore). The amount/commitment come from public chain data,
 * so nothing here trusts the executor or server.
 */
import { ethers, Signer } from 'ethers';
import { generateCommitmentData, resolveOutputNote, invalidateLeafCache, reconstructLeaf, type TokenInfo } from './zkHandler';
import { postPrecommitment, fetchPrecommitmentByValue } from './precommitmentStore';
import { backupNoteWithConfirmation } from './commitmentStore';
import { currentVaultId } from './vaultRegistry';
import { deriveEncKey, encryptBlob, decryptBlob } from './noteAuth';

const PENDING_PREFIX = 'siphon-pending-output-';

interface PendingOutputNote {
  nullifier?: string;   // plaintext nullifier — never written to localStorage
  secret?: string;      // plaintext secret — never written to localStorage
  enc?: { enc_blob: string; iv: string }; // AES-GCM(wallet key) of {nullifier,secret} — local fallback if Supabase upload fails
  precommitment: string;
  nullifierHash: string;
  chainId: number;
  symbol: string;
  tokenAddress: string;
  decimals: number;
}

function pendingKey(chainId: number, symbol: string, precommitment: string): string {
  return `${PENDING_PREFIX}${chainId}-${symbol}-${precommitment}`;
}

/**
 * Generate the output note's secret material and persist a pending record. Returns the
 * `precommitment` to attach to the strategy (the only field the executor needs).
 */
export async function createVaultOutputNote(
  chainId: number,
  token: TokenInfo,
  signer?: Signer | null,
): Promise<{ precommitment: string; backedUp: boolean }> {
  // Amount is irrelevant to the precommitment (= H(nullifier, secret)); pass '0'.
  const cd = await generateCommitmentData(chainId, token, '0');
  const tokenAddress = token.symbol === 'ETH' ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : token.address;

  // CRITICAL: the note's secret MUST be durably backed up (Supabase precommitment row) or the funds
  // are stranded the moment the browser cache is cleared — the executor only ever gets the PUBLIC
  // precommitment, never the nullifier/secret. Several callers (Discover/DetailsModal, quickSwapRun)
  // pass no signer, which silently skipped the backup entirely. Fall back to the connected signer so
  // the backup is never skipped just because a caller forgot to thread the signer through.
  let s = signer ?? null;
  if (!s) {
    try { const { getSigner } = await import('./nexus'); s = getSigner(); } catch { /* none */ }
  }

  const pending: PendingOutputNote = {
    nullifier: cd.nullifier,
    secret: cd.secret,
    precommitment: cd.precommitment,
    nullifierHash: cd.nullifierHash ?? '',
    chainId,
    symbol: token.symbol,
    tokenAddress,
    decimals: token.decimals,
  };
  // Encrypt {nullifier,secret} with the wallet-derived key and keep it in the pending record too.
  // Local fallback so a Supabase upload failure can't permanently strand the funds — the resolver
  // recovers the secret from here if the server copy is missing. Plaintext secret still never
  // touches localStorage (only the AES-GCM ciphertext does).
  let enc: { enc_blob: string; iv: string } | undefined;
  if (s) {
    try {
      const key = await deriveEncKey(s);
      enc = await encryptBlob(key, { nullifier: cd.nullifier, secret: cd.secret });
    } catch (e) {
      console.warn('[OutputNote] local secret encryption failed (will rely on server copy):', e);
    }
  }
  localStorage.setItem(pendingKey(chainId, token.symbol, cd.precommitment), JSON.stringify({
    precommitment: pending.precommitment,
    nullifierHash: pending.nullifierHash,
    chainId:       pending.chainId,
    symbol:        pending.symbol,
    tokenAddress:  pending.tokenAddress,
    decimals:      pending.decimals,
    ...(enc ? { enc } : {}),
  }));

  // Upload to Supabase (via the executor) so the secret survives across devices / cache clears.
  // Retry a few times — this is the durable backup and must not fail silently on a transient blip.
  let backedUp = false;
  if (s) {
    for (let attempt = 0; attempt < 3 && !backedUp; attempt++) {
      try {
        await postPrecommitment(s, {
          nullifier:     cd.nullifier,
          secret:        cd.secret,
          precommitment: cd.precommitment,
          asset:         token.symbol,
          chainId,
        });
        backedUp = true;
        console.log(`[OutputNote] precommitment backed up to server: ${cd.precommitment}`);
      } catch (e) {
        console.warn(`[OutputNote] precommitment upload attempt ${attempt + 1}/3 failed:`, e);
        await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  if (!backedUp) {
    console.error(`[OutputNote] ⚠️ precommitment NOT backed up to server (no signer / upload failed) — this note's funds are recoverable ONLY from this browser until you clear cache. precommitment=${cd.precommitment}`);
  }

  return { precommitment: cd.precommitment, backedUp };
}

/**
 * Resolve every pending output note whose deposit has landed on-chain: read the Deposited
 * event, write a spendable localStorage note, sync it to the server (best-effort), and drop the
 * pending record. Safe to call repeatedly (e.g. from the balance/notes refresh loop). Returns
 * the number of notes resolved this pass.
 *
 * `chainId` scopes the pass to one chain's pending notes — the balance refresh passes its
 * active chain so a dead note on ANOTHER chain (e.g. stale Sepolia leftovers grinding through
 * a rate-limited RPC) can never stall the balance you're actually looking at.
 */
export async function resolvePendingOutputNotes(signer?: Signer | null, chainId?: number): Promise<number> {
  if (typeof localStorage === 'undefined') return 0;

  const prefix = chainId != null ? `${PENDING_PREFIX}${chainId}-` : PENDING_PREFIX;
  const pendingKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) pendingKeys.push(k);
  }
  if (pendingKeys.length === 0 && !signer) return 0; // with a signer, still run server-side recovery below

  // Fetch the server's pending precommitment list once so we don't make a
  // round-trip + wallet sig request per resolved note inside the loop.
  let serverPending: Awaited<ReturnType<typeof import('./precommitmentStore').fetchPendingPrecommitments>> = [];
  if (signer) {
    try {
      const { fetchPendingPrecommitments } = await import('./precommitmentStore');
      serverPending = await fetchPendingPrecommitments(signer);
    } catch { /* best-effort */ }
  }

  let resolved = 0;
  for (const k of pendingKeys) {
    let rec: PendingOutputNote;
    try {
      rec = JSON.parse(localStorage.getItem(k) || '{}');
    } catch {
      continue;
    }
    if (!rec.precommitment || !rec.tokenAddress) continue;

    try {
      const hit = await resolveOutputNote(rec.tokenAddress, rec.precommitment, rec.chainId);
      if (!hit) continue; // deposit not on-chain yet — try again next pass

      const humanAmount = ethers.formatUnits(hit.amount, rec.decimals);
      const { noteKey: mkNoteKey } = await import('./localNoteStore');
      const noteKey = mkNoteKey(rec.chainId, rec.symbol, hit.commitment);

      // Recover the secret: prefer the server precommitment list, then the locally-encrypted copy
      // stored in the pending record (resilient to a Supabase upload/auth failure).
      const serverMatch = serverPending.find(p => p.decrypted.precommitment === rec.precommitment);
      let nullifier = rec.nullifier ?? serverMatch?.decrypted.nullifier;
      let secret    = rec.secret    ?? serverMatch?.decrypted.secret;
      if ((!nullifier || !secret) && rec.enc && signer) {
        try {
          const key = await deriveEncKey(signer);
          const dec = await decryptBlob<{ nullifier: string; secret: string }>(key, rec.enc.enc_blob, rec.enc.iv);
          nullifier = nullifier ?? dec.nullifier;
          secret    = secret    ?? dec.secret;
        } catch { /* ignore — fall through to metadata-only note */ }
      }

      // Consistency gate: the recovered (nullifier, secret) MUST reproduce the on-chain leaf
      // (Poseidon(amount, Poseidon(nullifier, secret)) === commitment), or the note is unspendable
      // — the withdraw circuit would reject it with a bare Merkle assert. If a recovery source
      // handed us mismatched secrets, refuse to write a poisoned note and keep the pending record
      // so a later pass / explicit repair (from the authoritative precommitment row) can fix it.
      let secretsConsistent = false;
      if (nullifier && secret) {
        try {
          const labelRaw = (hit as { label?: string }).label ?? (rec as { label?: string }).label;
          if (labelRaw != null && String(labelRaw).trim() !== '') {
            const { reconstructLeaf } = await import('./zkHandler');
            const { leaf } = await reconstructLeaf(
              BigInt(nullifier), BigInt(secret), BigInt(hit.amount), BigInt(labelRaw),
            );
            secretsConsistent = leaf === BigInt(hit.commitment);
            if (!secretsConsistent) {
              console.warn(`[OutputNote] recovered secret for ${rec.precommitment} does NOT reproduce leaf ${hit.commitment} — not writing a poisoned note; keeping pending for repair`);
            }
          } else {
            console.warn(`[OutputNote] missing Hard ASP label for ${hit.commitment} — keeping pending`);
          }
        } catch { /* treat as inconsistent — fall through to metadata-only */ }
      }

      if (signer && nullifier && secret && secretsConsistent) {
        // Full resolved note — encrypt nullifier + secret + label.
        const labelRaw = (hit as { label?: string }).label ?? (rec as { label?: string }).label;
        const { writeNote } = await import('./localNoteStore');
        await writeNote(noteKey, {
          nullifier,
          secret,
          commitment:    hit.commitment,
          precommitment: rec.precommitment,
          nullifierHash: rec.nullifierHash,
          label:         labelRaw != null ? String(labelRaw) : undefined,
          amount:        humanAmount,
          spent:         false,
        }, signer);
      } else {
        // No signer or secrets unavailable — skip the write entirely.
        // Writing a stub with no enc_blob would block syncFromServer from writing the real
        // encrypted note into this key slot (rank-merge branch fires, never overwrites).
        // The pending-output record is preserved; the next signed resolve pass will write properly.
      }

      // Resolve on Supabase: write spendable commitment, mark precommitment resolved — ONLY when
      // the secrets are consistent (never push a poisoned note to the server backup).
      if (signer && secretsConsistent) {
        try {
          await backupNoteWithConfirmation(
            signer,
            {
              nullifier:     nullifier!,
              secret:        secret!,
              commitment:    hit.commitment,
              precommitment: rec.precommitment,
              nullifierHash: rec.nullifierHash,
              amount:        humanAmount,
              chainId:       rec.chainId,
              vaultId:       (await currentVaultId(rec.chainId, rec.symbol)) ?? undefined,
            },
            rec.symbol,
            'vault-output',
          );
        } catch (e) {
          console.warn('[OutputNote] commitment server sync failed (localStorage still holds it):', e);
        }
        // Mark the pending precommitment resolved.
        try {
          const { resolvePrecommitment } = await import('./precommitmentStore');
          if (serverMatch) await resolvePrecommitment(signer, serverMatch.id);
        } catch { /* best-effort */ }
      }

      // Bust the cached leaf scan for this token so the spendable-balance scan re-reads the
      // tree and includes the newly-deposited leaf (otherwise the note looks "not on-chain").
      try { invalidateLeafCache(rec.tokenAddress); } catch { /* best-effort */ }

      // Only drop the pending record once the note is FULLY resolved (secret written via the
      // signer branch AND self-consistent). On the metadata-only / inconsistent branch KEEP it —
      // rec.enc is the only local copy of the secret, and a later signed pass / repair needs it.
      // Deleting it here permanently strands the output funds (the normal TWAP/grid vault
      // re-deposit case, since the 60s balance poll calls this with no signer).
      const fullyResolved = !!(signer && nullifier && secret && secretsConsistent);
      if (fullyResolved) {
        localStorage.removeItem(k);
        console.log(`[OutputNote] resolved ${rec.symbol} note: ${humanAmount} (commitment ${hit.commitment})`);
        resolved += 1;
      } else {
        console.log(`[OutputNote] ${rec.symbol} note seen on-chain (${humanAmount}) but not fully resolved — keeping pending for signed pass`);
      }
    } catch (e) {
      console.warn('[OutputNote] resolve failed for', k, e);
    }
  }

  // Server-side recovery: an output note whose LOCAL pending record was already deleted (e.g. by an
  // older no-signer poll before the keep-secret fix) can still be rebuilt from the Supabase
  // precommitment, which holds the nullifier+secret. Finalize any pending precommitment whose
  // deposit is now on-chain and isn't already spendable locally.
  if (signer && serverPending.length > 0) {
    const { getTokens } = await import('./networks');
    const { writeNote } = await import('./localNoteStore');
    const { resolvePrecommitment } = await import('./precommitmentStore');
    const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    for (const sp of serverPending) {
      try {
        const { nullifier, secret, precommitment, asset, chainId } = sp.decrypted;
        if (!precommitment || !asset) continue;
        const symbol = String(asset).toUpperCase();
        // Spare-pool precommitments are chain-agnostic change-note placeholders stored with
        // asset:'POOL', chainId:0 as a sentinel — never tied to an on-chain deposit. They only
        // reach here because the flat pending-status query doesn't filter by asset type. Skip them:
        // getTokens(0)/getNetwork(0) throws "Unsupported chainId: 0", which (though caught per-entry)
        // slowed this loop and on Sepolia starved real output notes from resolving (empty balance).
        if (symbol === 'POOL' || !chainId) continue;
        const tok = getTokens(chainId)[symbol];
        const tokenAddress = symbol === 'ETH' ? NATIVE : tok?.address;
        if (!tokenAddress) continue;
        const hit = await resolveOutputNote(tokenAddress, precommitment, chainId);
        if (!hit) continue; // deposit not on-chain yet

        // The precommitment row's (nullifier, secret) is the AUTHORITATIVE source (written once at
        // strategy creation, never mutated). Verify it reproduces the on-chain leaf before writing.
        let authConsistent = false;
        try {
          const labelRaw = (hit as { label?: string }).label;
          if (!labelRaw) { authConsistent = false; }
          else {
            const { leaf } = await reconstructLeaf(
              BigInt(nullifier), BigInt(secret), BigInt(hit.amount), BigInt(labelRaw),
            );
            authConsistent = leaf === BigInt(hit.commitment);
          }
        } catch { authConsistent = false; }
        if (!authConsistent) {
          console.warn(`[OutputNote] server precommitment ${precommitment} secrets don't reproduce leaf ${hit.commitment} — skipping (backup itself is inconsistent)`);
          continue;
        }

        const { noteKey: mkNoteKey } = await import('./localNoteStore');
        const noteKey = mkNoteKey(chainId, symbol, hit.commitment);
        const existing = localStorage.getItem(noteKey);
        // A note is "already good" only if it's readable AND its stored secret reproduces the leaf.
        // A readable-but-inconsistent note (a stale artifact from an older resolve) must be REPAIRED
        // by overwriting it with the authoritative secrets above — NOT skipped. The old code skipped
        // any readable note, which froze corrupt notes in place forever (unspendable "phantom" funds).
        let alreadyGood = false;
        if (existing) {
          try {
            const parsed = JSON.parse(existing);
            if (parsed.enc_blob || parsed.nullifier_enc) {
              const { readNote } = await import('./localNoteStore');
              const cur = await readNote(noteKey, signer);
              if (cur?.nullifier && cur?.secret) {
                const labelRaw = cur.label || (hit as { label?: string }).label;
                if (labelRaw) {
                  const { leaf } = await reconstructLeaf(
                    BigInt(cur.nullifier), BigInt(cur.secret), BigInt(hit.amount), BigInt(labelRaw),
                  );
                  alreadyGood = leaf === BigInt(hit.commitment);
                }
              }
            }
          } catch { alreadyGood = false; }
        }
        if (alreadyGood) continue; // already spendable & consistent
        if (existing) console.log(`[OutputNote] repairing readable-but-inconsistent note ${noteKey} from authoritative precommitment`);

        const humanAmount = ethers.formatUnits(hit.amount, tok ? tok.decimals : 18);
        // nullifierHash left '' — the withdraw path recomputes it from the nullifier.
        const nullifierHash = await (async () => {
          try {
            const { buildPoseidon } = await import('circomlibjs');
            const p = await buildPoseidon();
            return BigInt(p.F.toObject(p([BigInt(nullifier)]))).toString();
          } catch { return ''; }
        })();
        await writeNote(noteKey, {
          nullifier, secret, commitment: hit.commitment, precommitment, nullifierHash,
          amount: humanAmount, spent: false,
        }, signer);
        try {
          await backupNoteWithConfirmation(signer, {
            nullifier, secret, commitment: hit.commitment, precommitment, nullifierHash,
            amount: humanAmount, chainId, vaultId: (await currentVaultId(chainId, symbol)) ?? undefined,
          }, symbol, 'vault-output');
        } catch { /* best-effort */ }
        try { await resolvePrecommitment(signer, sp.id); } catch { /* best-effort */ }
        try { invalidateLeafCache(tokenAddress); } catch { /* best-effort */ }
        resolved += 1;
        console.log(`[OutputNote] recovered ${symbol} note from server precommitment: ${humanAmount} (commitment ${hit.commitment})`);
      } catch (e) {
        console.warn('[OutputNote] server recovery failed for precommitment', sp.id, e);
      }
    }
  }

  return resolved;
}

/**
 * Repair a single spendable note whose stored secret material no longer reproduces its on-chain
 * leaf (a corrupt/stale artifact from an older resolve). The authoritative (nullifier, secret) is
 * the precommitment row written at strategy-creation time — fetched here by VALUE regardless of
 * status (pending/in_use/resolved), since a once-resolved precommitment is excluded from the
 * `?status=pending` recovery loop above. Verifies the authoritative secrets actually reproduce the
 * leaf before overwriting, so a repair can never make things worse. Returns true if repaired.
 */
export async function repairInconsistentOutputNote(
  signer: Signer,
  params: {
    precommitment: string;
    commitment: string;
    amountWei: bigint;
    chainId: number;
    symbol: string;
    tokenAddress: string;
    decimals: number;
  },
): Promise<boolean> {
  const { commitment, amountWei, chainId, symbol, tokenAddress, decimals } = params;
  let { precommitment } = params;

  // If the note didn't carry a precommitment (e.g. it came via syncWalletNotesFromServer, which
  // writes precommitment:''), recover it from the on-chain Deposited event for this commitment.
  if (!precommitment) {
    try {
      const { resolvePrecommitmentByCommitment } = await import('./zkHandler');
      const onchain = await resolvePrecommitmentByCommitment(tokenAddress, commitment, chainId);
      if (onchain?.precommitment) precommitment = onchain.precommitment;
    } catch (e) { console.warn('[OutputNote] repair: on-chain precommitment lookup failed:', e); }
  }
  if (!precommitment) {
    console.warn('[OutputNote] cannot repair note without a precommitment (stored or on-chain):', commitment);
    return false;
  }
  let auth;
  try {
    auth = await fetchPrecommitmentByValue(signer, precommitment);
  } catch (e) {
    console.warn('[OutputNote] repair: precommitment fetch failed:', e);
    return false;
  }
  if (!auth) {
    console.warn(`[OutputNote] repair: no server precommitment row for ${precommitment} — secret not recoverable`);
    return false;
  }
  const { nullifier, secret } = auth.decrypted;
  if (!nullifier || !secret) return false;

  // The authoritative secrets MUST reproduce the on-chain leaf, or they're not the right ones.
  try {
    const labelRaw = (auth as { label?: string }).label;
    if (!labelRaw) {
      console.warn(`[OutputNote] repair: missing Hard ASP label for ${precommitment}`);
      return false;
    }
    const { leaf } = await reconstructLeaf(BigInt(nullifier), BigInt(secret), amountWei, BigInt(labelRaw));
    if (leaf !== BigInt(commitment)) {
      console.warn(`[OutputNote] repair: authoritative secrets for ${precommitment} still don't reproduce leaf ${commitment} — cannot repair`);
      return false;
    }
  } catch {
    return false;
  }

  const humanAmount = ethers.formatUnits(amountWei, decimals);
  const { writeNote, noteKey: mkNoteKey } = await import('./localNoteStore');
  const repairKey = mkNoteKey(chainId, symbol, commitment);
  // Compute nullifierHash from nullifier
  let repairNullifierHash = '';
  try {
    const { buildPoseidon } = await import('circomlibjs');
    const rp = await buildPoseidon();
    repairNullifierHash = BigInt(rp.F.toObject(rp([BigInt(nullifier)]))).toString();
  } catch { /* best-effort */ }
  await writeNote(repairKey, {
    nullifier, secret, commitment, precommitment, nullifierHash: repairNullifierHash,
    amount: humanAmount, spent: false,
  }, signer);
  // Best-effort: refresh the server commitment backup with the corrected secrets.
  try {
    await backupNoteWithConfirmation(signer, {
      nullifier, secret, commitment, precommitment, nullifierHash: repairNullifierHash,
      amount: humanAmount, chainId, vaultId: (await currentVaultId(chainId, symbol)) ?? undefined,
    }, symbol, 'vault-output');
  } catch { /* best-effort */ }
  try { invalidateLeafCache(tokenAddress); } catch { /* best-effort */ }
  console.log(`[OutputNote] repaired ${symbol} note ${repairKey} from authoritative precommitment ${precommitment}`);
  return true;
}

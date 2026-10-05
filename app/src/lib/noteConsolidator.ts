/**
 * Note consolidation: when a user accumulates >6 live notes for an asset, auto-merge
 * down to ≤4 using Vault.merge() before the next withdrawal would exceed the N=6 cap.
 *
 * Hard ASP merge(N): N input notes → 1 consolidated note.
 * Public signals: [stateRoot, aspRoot, mergedCommitment, mergedLabel, nullifierHash[0..N-1]]
 */
import { ethers, Contract } from 'ethers';
// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();
import { prepareMergeTransaction } from './generateProof';
import { getSigner } from './nexus';
import { getWalletWriteAuthHeaders } from './walletAuthHeaders';
import merkleTreeAbiJson from './abi/MerkleTree.json';
import { invalidateLeafCache, getOnChainLeaves, resolveVault, getReadProvider } from './zkHandler';
import type { TokenInfo } from './zkHandler';

const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const TREE_DEPTH = 32;
const MAX_NOTES = 6;
const CONSOLIDATE_THRESHOLD = MAX_NOTES; // trigger when live notes == threshold

// Same Poseidon zeros as zkHandler (depth 32)
const ZEROS: bigint[] = [
  0n,
  14744269619966411208579211824598458697587494354926760081771325075741142829156n,
  7423237065226347324353380772367382631490014989348495481811164164159255474657n,
  11286972368698509976183087595462810875513684078608517520839298933882497716792n,
  3607627140608796879659380071776844901612302623152076817094415224584923813162n,
  19712377064642672829441595136074946683621277828620209496774504837737984048981n,
  20775607673010627194014556968476266066927294572720319469184847051418138353016n,
  3396914609616007258851405644437304192397291162432396347162513310381425243293n,
  21551820661461729022865262380882070649935529853313286572328683688269863701601n,
  6573136701248752079028194407151022595060682063033565181951145966236778420039n,
  12413880268183407374852357075976609371175688755676981206018884971008854919922n,
  14271763308400718165336499097156975241954733520325982997864342600795471836726n,
  20066985985293572387227381049700832219069292839614107140851619262827735677018n,
  9394776414966240069580838672673694685292165040808226440647796406499139370960n,
  11331146992410411304059858900317123658895005918277453009197229807340014528524n,
  15819538789928229930262697811477882737253464456578333862691129291651619515538n,
  19217088683336594659449020493828377907203207941212636669271704950158751593251n,
  21035245323335827719745544373081896983162834604456827698288649288827293579666n,
  6939770416153240137322503476966641397417391950902474480970945462551409848591n,
  10941962436777715901943463195175331263348098796018438960955633645115732864202n,
  15019797232609675441998260052101280400536945603062888308240081994073687793470n,
  11702828337982203149177882813338547876343922920234831094975924378932809409969n,
  11217067736778784455593535811108456786943573747466706329920902520905755780395n,
  16072238744996205792852194127671441602062027943016727953216607508365787157389n,
  17681057402012993898104192736393849603097507831571622013521167331642182653248n,
  21694045479371014653083846597424257852691458318143380497809004364947786214945n,
  8163447297445169709687354538480474434591144168767135863541048304198280615192n,
  14081762237856300239452543304351251708585712948734528663957353575674639038357n,
  16619959921569409661790279042024627172199214148318086837362003702249041851090n,
  7022159125197495734384997711896547675021391130223237843255817587255104160365n,
  4114686047564160449611603615418567457008101555090703535405891656262658644463n,
  12549363297364877722388257367377629555213421373705596078299904496781819142130n,
];

function buildMerklePath(
  leaves: bigint[],
  leafIndex: number,
  poseidonHash: (a: bigint, b: bigint) => bigint,
): { pathElements: bigint[]; pathIndices: number[] } {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let levelNodes = leaves.slice();
  let idx = leafIndex;
  for (let level = 0; level < TREE_DEPTH; level++) {
    const isRight = idx % 2;
    pathIndices.push(isRight);
    const sibling = isRight === 1 ? idx - 1 : idx + 1;
    pathElements.push(sibling < levelNodes.length ? levelNodes[sibling] : ZEROS[level]);
    const next: bigint[] = [];
    for (let i = 0; i < levelNodes.length; i += 2) {
      next.push(poseidonHash(levelNodes[i], i + 1 < levelNodes.length ? levelNodes[i + 1] : ZEROS[level]));
    }
    levelNodes = next;
    idx = Math.floor(idx / 2);
  }
  return { pathElements, pathIndices };
}

/**
 * Check if consolidation is needed and, if so, merge the oldest MAX_NOTES notes into one.
 * Returns the new merged commitment key on success, null if no consolidation was needed,
 * or an error string on failure.
 */
export async function consolidateIfNeeded(
  chainId: number,
  token: TokenInfo,
  opts?: { minNotes?: number },
): Promise<{ merged: true; key: string } | { merged: false } | { error: string }> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const poseidonHash = (a: bigint, b: bigint): bigint => BigInt(F.toObject(poseidon([a, b])));

  const { scanNoteMeta, readNote, writeNote, markNoteSpent } = await import('./localNoteStore');
  const signer = getSigner();
  if (!signer) return { error: 'Wallet not connected' };

  const tokenAddress = token.symbol === 'ETH' ? NATIVE_TOKEN : token.address;
  const noteMetas = scanNoteMeta(`${chainId}-${token.symbol}-`);
  const unspent = noteMetas.filter(m => m.spent === 'false' && m.commitment && m.amount);
  const minNotes = opts?.minNotes ?? CONSOLIDATE_THRESHOLD;

  if (unspent.length < minNotes) return { merged: false };

  try {
    const { assertHardAspLive } = await import("./hardAspLive");
    await assertHardAspLive(chainId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Hard ASP not live" };
  }

  console.log(`[consolidate] ${unspent.length} notes for ${token.symbol} — merging ${MAX_NOTES}`);

  // Fetch on-chain leaves + root. getOnChainLeaves is the shared verified path:
  // indexer fast-path (size-checked against the tree, this is a PROOF path) with
  // chunked-getLogs fallback, cached + inflight-deduped.
  const provider = getReadProvider(chainId);
  const { vault, merkleTreeAddress: merkleTreeAddr } = await resolveVault(tokenAddress, chainId);
  const merkleTreeContract = new Contract(merkleTreeAddr, merkleTreeAbiJson.abi as ethers.InterfaceAbi, provider);
  const leaves = await getOnChainLeaves(tokenAddress, chainId);

  const onChainRoot = BigInt((await merkleTreeContract.getRoot()).toString());

  interface MergeNote {
    key: string;
    nullifier: string;
    secret: string;
    label: string;
    amountWei: bigint;
    leafIndex: number;
    createdAt: number; // deposit timestamp — 2nd-priority tiebreaker (oldest first) among equal values
  }

  const { readDepositInfo, LABEL_REVOKED, LABEL_RAGEQUIT } = await import('./depositLabel');
  const { labelInAssociationSet } = await import('./aspProof');

  // Pick up to MAX_NOTES ADMITTED notes (cross-label allowed) sorted by value for the circuit.
  const mergeCandidates: MergeNote[] = [];
  for (const meta of unspent) {
    const data = await readNote(meta.key, signer);
    if (!data?.nullifier || !data.secret || !data.commitment) continue;
    const label = String(data.label || "").trim();
    if (!label || label === "0") continue;
    // Only ADMITTED notes are mergeable: the merge circuit proves each input's label ∈ aspRoot
    // (dual-inclusion), so a not-yet-admitted ("checking") note would make the proof fail. Also NEVER
    // consolidate a revoked / ragequit-finalized note (merging would shed the revocation flag into the
    // clean inherited label). On a read error, fail SAFE: skip the note.
    try {
      const info = await readDepositInfo(vault, label);
      if (info && (info.status === LABEL_REVOKED || info.status === LABEL_RAGEQUIT)) continue;
      // Admitted = label in the ASP association set (Pending-but-in-set is spendable; see classifyAspNote).
      const inAsp = await labelInAssociationSet(label);
      if (!inAsp) continue; // checking / not-yet-admitted → not mergeable
    } catch {
      continue;
    }
    const commitment = BigInt(data.commitment);
    const leafIndex = leaves.findIndex(l => l === commitment);
    if (leafIndex === -1) continue;
    const amountWei = BigInt(ethers.parseUnits(data.amount.toString(), token.decimals).toString());
    mergeCandidates.push({
      key: meta.key,
      nullifier: data.nullifier,
      secret: data.secret,
      label,
      amountWei,
      leafIndex,
      // createdAt from the note meta (deposit time). Absent (legacy notes) → treat as oldest (0) so
      // they sort first among ties deterministically.
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
    });
  }

  // SELECT the 6 HIGHEST-VALUE notes to consolidate (reduces fragmentation where the value is, and the
  // merged note inherits the largest note's already-admitted label — greedy). Deterministic ordering so
  // the selection + the inherited label never depend on scan order:
  //   primary:   value DESCENDING (largest first)
  //   secondary: createdAt ASCENDING (oldest deposit first) — the tiebreaker when amounts are equal.
  const selectionSort = (a: MergeNote, b: MergeNote) => {
    if (a.amountWei !== b.amountWei) return a.amountWei > b.amountWei ? -1 : 1; // value desc
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;          // createdAt asc
    // Final stable tiebreak (equal value AND equal timestamp) — leafIndex asc, so the order is total.
    return a.leafIndex - b.leafIndex;
  };
  const selected = [...mergeCandidates].sort(selectionSort).slice(0, MAX_NOTES);

  const N = selected.length;
  if (N < 2) {
    return { merged: false };
  }

  // The merge circuit enforces `mergedLabel === inLabel[N-1]` (greedy — largest note's label at index
  // N-1). `selected` is value-DESCENDING (largest at index 0), so REVERSE it for the circuit input order
  // → largest lands at N-1. The two orderings are decoupled on purpose: selection is by highest value,
  // circuit order is ascending. After reversal toMerge[N-1] is the largest (with the deterministic
  // tiebreak applied), and its label is what the merged note inherits.
  const toMerge = [...selected].reverse();

  const { loadAspWitness } = await import("./aspProof");
  const { hashCommitment } = await import("./noteCrypto");
  // Merged label = the largest selected note's label (now at index N-1). Real, admitted, governable.
  const mergedLabel = toMerge[N - 1].label;
  const aspW = await loadAspWitness(toMerge.map((n) => n.label));
  if ("error" in aspW) return { error: aspW.error };

  // Generate fresh secrets for the merge output note — no pool dependency.
  const { modField } = await import('./zkHandler');
  const randHex = () => Array.from(crypto.getRandomValues(new Uint8Array(31))).map(b => b.toString(16).padStart(2, '0')).join('');
  const mergedNullifier = modField(BigInt('0x' + randHex()));
  const mergedSecret    = modField(BigInt('0x' + randHex()));
  const mergedValue     = toMerge.reduce((acc, n) => acc + n.amountWei, 0n);
  const mergedPrecommitment = BigInt(F.toObject(poseidon([mergedNullifier, mergedSecret])));
  const mergedCommitment = await hashCommitment(mergedValue, BigInt(mergedLabel), mergedPrecommitment);

  // Build Merkle paths and pre-compute nullifier hashes (public inputs)
  const pathElementsAll = toMerge.map(n => buildMerklePath(leaves, n.leafIndex, poseidonHash).pathElements.map(v => v.toString()));
  const pathIndicesAll = toMerge.map(n => buildMerklePath(leaves, n.leafIndex, poseidonHash).pathIndices.map(String));
  const inputNullifierHashes = toMerge.map(n => BigInt(F.toObject(poseidon([BigInt(n.nullifier)]))).toString());

  const circuitInput = {
    stateRoot:        onChainRoot.toString(),
    aspRoot:          aspW.aspRoot,
    mergedCommitment: mergedCommitment.toString(),
    mergedLabel,
    nullifierHash:    inputNullifierHashes,
    mergeNullifier:   mergedNullifier.toString(),
    mergeSecret:      mergedSecret.toString(),
    inValue:          toMerge.map(n => n.amountWei.toString()),
    inNullifier:      toMerge.map(n => n.nullifier),
    inSecret:         toMerge.map(n => n.secret),
    inLabel:          toMerge.map(n => n.label),
    pathElements:     pathElementsAll,
    pathIndices:      pathIndicesAll,
    aspPathElements:  aspW.aspPathElements,
    aspPathIndices:   aspW.aspPathIndices,
  };

  // Also fetch server commitments so we can mark input notes spent server-side after tx.
  const serverCommitmentIds: Record<string, string> = {};
  try {
    const { fetchCommitments } = await import('./commitmentStore');
    const serverComms = await fetchCommitments(signer);
    for (const c of serverComms) {
      if (c.spent === 'false' || c.spent === 'pending') {
        const key = `siphon-note-${c.decrypted.chainId}-${token.symbol}-${c.decrypted.commitment}`;
        serverCommitmentIds[key] = c.id;
      }
    }
  } catch (e) {
    console.warn('[consolidate] Server commitment fetch failed, server-side marking skipped:', e);
  }

  console.log(`[consolidate] Generating M${N} merge proof…`);
  const { proof, publicSignals } = await prepareMergeTransaction(circuitInput, N);
  // Hard ASP: [stateRoot, aspRoot, mergedCommitment, mergedLabel, nullifierHash[0..N-1]]
  const mergedCommitmentOnChain = BigInt(publicSignals[2]);
  const mergedLabelOnChain = publicSignals[3];
  const nullifierHashes: string[] = toMerge.map((_, i) => publicSignals[4 + i]);
  const mergedNullifierHash = BigInt(F.toObject(poseidon([mergedNullifier]))).toString();

  // Persist merge output secrets before tx as an encrypted pending note so recovery is possible
  // if the page crashes between mining and the post-confirm writeNote call.
  const { writeNoteTyped, noteKey: mkNoteKeyPre } = await import('./localNoteStore');
  const preMergeKey = mkNoteKeyPre(chainId, token.symbol, mergedCommitmentOnChain.toString());
  await writeNoteTyped(chainId, token.symbol, {
    nullifier:     mergedNullifier.toString(),
    secret:        mergedSecret.toString(),
    commitment:    mergedCommitmentOnChain.toString(),
    precommitment: mergedPrecommitment.toString(),
    nullifierHash: mergedNullifierHash,
    label:         mergedLabelOnChain,
    amount:        ethers.formatUnits(mergedValue, token.decimals),
    spent:         'pending',
  }, signer);

  // Post to Supabase BEFORE the tx — so a crash between mining and postCommitment
  // doesn't leave the merged note invisible to cross-device sync.
  let mergeServerId: string | undefined;
  try {
    const { backupNoteWithConfirmation } = await import('./commitmentStore');
    const { currentVaultId } = await import('./vaultRegistry');
    const mergeVaultId = (await currentVaultId(chainId, token.symbol)) ?? undefined;
    const _mergeBackup = await backupNoteWithConfirmation(
      signer,
      {
        nullifier:     mergedNullifier.toString(),
        secret:        mergedSecret.toString(),
        commitment:    mergedCommitmentOnChain.toString(),
        amount:        ethers.formatUnits(mergedValue, token.decimals),
        chainId,
        nullifierHash: mergedNullifierHash,
        precommitment: mergedPrecommitment.toString(),
        label:         mergedLabelOnChain,
        vaultId:       mergeVaultId,
      },
      token.symbol,
      'merge',
    );
    mergeServerId = _mergeBackup.id ?? undefined;
  } catch (e) {
    console.warn('[consolidate] Pre-tx postCommitment failed (non-blocking):', e);
  }

  // Submit the merge via the RELAYER — not the user's wallet. Consolidation happens mid-withdrawal,
  // so a MetaMask popup here would be a jarring interruption. Merge moves no funds and its output is
  // the proof-bound mergedCommitment, so the relayer can't redirect anything (relayer-safe, zero
  // contract change). The executor's send_tx only returns after a status==1 receipt, so a 200 here
  // means the merge is mined and the input nullifiers are genuinely spent — same guarantee tx.wait()
  // gave. On any failure/uncertain outcome we throw into the existing catch, which quarantines the
  // pre-written pending merged note and leaves the input notes unspent for retry.
  // Depositor for the merged note's DepositInfo — the note owner (this wallet), NEVER the relayer. The
  // merged note MUST stay revocable + ragequittable by its owner (latest-note-wins), so both the relayer
  // and the wallet-submit path forward this exact depositor + true mergedValue.
  const depositor = await signer.getAddress();

  // Wallet-submit fallback: build Entrypoint.merge(...) directly via MetaMask. Used when the relayer is
  // not configured or the relay fails. Preserves depositor + mergedValue identically to the relayer path.
  const submitMergeViaWallet = async (): Promise<string> => {
    const { getEntrypointContract } = await import('./handler');
    const asset = token.symbol === 'ETH' ? NATIVE_TOKEN : token.address;
    const entrypoint = await getEntrypointContract(signer);
    console.log('[consolidate] submitting merge via wallet (MetaMask)…');
    const tx = await entrypoint.getFunction('merge')(
      asset,
      depositor,
      mergedValue,
      onChainRoot,
      BigInt(aspW.aspRoot),
      nullifierHashes,
      mergedCommitmentOnChain,
      BigInt(mergedLabelOnChain),
      proof.pA,
      proof.pB,
      proof.pC,
      // Explicit gasLimit — merge verifies a Groth16 proof + inserts a leaf (depth-32 Poseidon); the
      // auto-estimate can under-forward to the inner PoseidonT3 calls (63/64 rule).
      { gasLimit: 2_000_000n },
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('wallet merge did not confirm');
    return receipt.hash ?? tx.hash;
  };

  // Try the relayer first (popup-free); on any relayer failure fall back to a wallet (MetaMask) submit.
  // Both preserve the depositor + mergedValue, so the merged note's DepositInfo is correct either way.
  const relayMerge = async (): Promise<string> => {
    const { getTradeExecutorBaseUrl } = await import('./tradeExecutorClient');
    // /relayMerge is write-challenge gated on the executor — attach a fresh wallet write signature
    // (X-Write-Signature / X-Write-Nonce) so the relayer path can't be driven anonymously.
    const writeHeaders = await getWalletWriteAuthHeaders(signer);
    const resp = await fetch(`${getTradeExecutorBaseUrl()}/relayMerge`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        chain_id: chainId,
        asset: token.symbol,                          // executor maps symbol → token address
        // Merged note DepositInfo: the note owner (this wallet, NOT the relayer) and the true merged
        // value (sum of inputs). The executor forwards both into Entrypoint.merge so the merged note
        // is revocable + ragequittable by the user.
        depositor,
        mergedValue: mergedValue.toString(),
        proof: {
          stateRoot:        onChainRoot.toString(),
          aspRoot:          aspW.aspRoot,
          nullifierHashes:  nullifierHashes.map(String),
          mergedCommitment: mergedCommitmentOnChain.toString(),
          mergedLabel:      mergedLabelOnChain,
          mergedValue:      mergedValue.toString(),
          pA: proof.pA.map(String),
          pB: proof.pB.map((row: unknown[]) => row.map(String)),
          pC: proof.pC.map(String),
        },
      }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body?.error || `relayMerge returned ${resp.status}`);
    const txHash: string | undefined = body?.tx_hash;
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error('relayMerge returned no valid transaction hash');
    }
    return txHash;
  };

  try {
    let txHash: string;
    try {
      txHash = await relayMerge();
      console.log('[consolidate] merge relayed, tx:', txHash);
    } catch (relayErr) {
      console.warn('[consolidate] relayer merge failed — falling back to wallet submit:', (relayErr as Error)?.message);
      txHash = await submitMergeViaWallet();
      console.log('[consolidate] merge wallet-submitted, tx:', txHash);
    }
    void txHash;
    // Invalidate immediately after mining so any subsequent getLeafSet sees the merged output leaf.
    invalidateLeafCache();
  } catch (txErr) {
    // Merge not confirmed — quarantine the pre-written pending note so it's not mistaken for a real
    // note, and leave the input nullifiers unspent so the next round/attempt can re-merge them.
    const { markNoteSpentTyped } = await import('./localNoteStore');
    markNoteSpentTyped(chainId, token.symbol, mergedCommitment.toString(), 'true');
    throw txErr;
  }

  // Mark all merged input notes spent: localStorage + server commitments table
  const { markCommitmentSpent } = await import('./commitmentStore');
  const { writeNullifier } = await import('./nullifierStore');
  for (const n of toMerge) {
    markNoteSpent(n.key);
    const serverId = serverCommitmentIds[n.key];
    if (serverId) {
      markCommitmentSpent(signer, serverId, 'true').catch(e =>
        console.warn('[consolidate] Failed to mark server commitment spent:', n.key, e)
      );
    }
    // Write spent nullifier to Supabase for cross-device detection
    const nh = inputNullifierHashes[toMerge.indexOf(n)];
    if (nh) {
      writeNullifier(signer, nh)
        .catch(e => console.warn('[consolidate] nullifier write failed:', e));
    }
  }

  // Confirm the pre-written pending note as spendable now that tx is mined.
  // Guard: never overwrite a quarantined ('true') note — only confirm pending→false.
  // preMergeKey already uses mergedCommitmentOnChain, so no stale-key cleanup needed.
  const mergedKey = preMergeKey;
  const existingMerged = localStorage.getItem(mergedKey);
  const existingSpent = existingMerged ? (JSON.parse(existingMerged).spent ?? 'false') : 'false';
  if (existingSpent !== 'true') {
    await writeNoteTyped(chainId, token.symbol, {
      nullifier:     mergedNullifier.toString(),
      secret:        mergedSecret.toString(),
      commitment:    mergedCommitmentOnChain.toString(),
      precommitment: mergedPrecommitment.toString(),
      nullifierHash: mergedNullifierHash,
      label:         mergedLabelOnChain,
      amount:        ethers.formatUnits(mergedValue, token.decimals),
      spent:         'false',
    }, signer);
  }

  // Advance server-side merged note from 'pending' → 'false' (confirmed on-chain).
  if (mergeServerId) {
    try {
      const { markCommitmentSpent } = await import('./commitmentStore');
      await markCommitmentSpent(signer, mergeServerId, 'false');
    } catch (e) {
      console.warn('[consolidate] Failed to confirm merged note on server:', e);
    }
  }

  // Refill withdrawal spare pool async (best-effort).
  try {
    const { ensurePool } = await import('./sparePool');
    ensurePool(signer);
  } catch { /* best-effort */ }

  console.log('[consolidate] Merged', N, 'notes into', mergedKey);
  return { merged: true, key: mergedKey };
}

/**
 * Cross-label merge when ≥2 unspent notes exist (no 6-note threshold).
 * Used before swap to combine split deposits into one spendable note.
 */
export async function mergeCrossLabelIfNeeded(
  chainId: number,
  token: TokenInfo,
): Promise<{ merged: true; key: string } | { merged: false } | { error: string }> {
  return consolidateIfNeeded(chainId, token, { minNotes: 2 });
}

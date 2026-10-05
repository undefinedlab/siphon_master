import { getSigner, getProvider, TOKEN_MAP, getTokenAllowance, approveToken } from './nexus';
import { getWalletWriteAuthHeaders } from './walletAuthHeaders';
import { ethers, Interface, Log, Contract, TransactionReceipt, BrowserProvider, Signer} from 'ethers';
import { generateCommitmentData, generateZKData, generateRagequitProof, TokenInfo, invalidateLeafCache, resolveVault } from './zkHandler';
import entrypointArtifact from "./abi/Entrypoint.json";
import nativeVaultAbiJson from './abi/NativeVault.json';
import merkleTreeAbiJson from './abi/MerkleTree.json';
import { getNetwork, getSelectedChainId, NATIVE_TOKEN as NATIVE } from './networks';
import { appendUserActivity, markUserActivityRagequit } from './userActivityLog';
import { chunkRagequitItems, markRagequitNotesFromChain } from './ragequitSpend';
import { isUserRejection } from './walletRejection';

function notifyVaultBalanceChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('siphon:vaultBalanceInvalidate'));
  }
}

const RELAY_WITHDRAW_TIMEOUT_MS = 120_000;

function isRelayerTransportError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '').toLowerCase();
  return (
    err instanceof TypeError ||
    /timed out|timeout|aborted|network|failed to fetch|auth challenge|econnrefused|enotfound|502|503|504|gateway/i.test(msg)
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Turn a raw wallet/ethers error into a short, user-facing message — no JSON dumps, no
 * `action="sendTransaction", reason="rejected", info={…}` noise in the toast.
 */
export function friendlyTxError(err: unknown, ctx?: "ragequit"): string {
  const e = err as { code?: unknown; reason?: string; shortMessage?: string; message?: string; info?: { error?: { code?: number } } };
  const raw = String(e?.shortMessage || e?.reason || e?.message || err || '');
  if (isUserRejection(err)) return 'Transaction rejected in your wallet.';
  if (/insufficient funds|insufficient balance|exceeds balance|have 0\.0/i.test(raw)) return 'Insufficient balance for this transaction.';
  if (/nullifier.*spent|already spent|NullifierAlreadySpent/i.test(raw)) {
    return ctx === "ragequit"
      ? "These funds were already returned to the depositing wallet."
      : "That note was already spent.";
  }
  if (/OnlyDepositor/i.test(raw)) {
    return ctx === "ragequit"
      ? "Connect the original depositing wallet to ragequit."
      : "Only the original depositor can do that.";
  }
  if (/invalidasproot|invalid asp root/i.test(raw))
    return 'Association set not published on-chain yet — wait for postman, then retry.';
  if (/invalidzkproof/i.test(raw)) return 'Proof could not be verified — refresh and try again.';
  if (/hard asp|aspPostman|ceremony|dev beacon|mpc ceremony|private vaults on/i.test(raw)) {
    const cleanAsp = (e?.shortMessage || e?.reason || raw).split(/[\n]/)[0].trim();
    return cleanAsp.length > 160 ? cleanAsp.slice(0, 160) + '…' : cleanAsp;
  }
  if (/in-flight transaction limit/i.test(raw)) return 'Your wallet has a pending transaction — wait for it to confirm and retry.';
  // Fallback: first clause only (drop the ethers detail after "(" or newline), truncated.
  const clean = (e?.shortMessage || e?.reason || raw).split(/[\n(]/)[0].trim();
  return clean.length > 140 ? clean.slice(0, 140) + '…' : (clean || 'Transaction failed.');
}

// --------- Constants ----------
// Chain + Entrypoint now come from the active network registry (Eth Sepolia / Base Sepolia).
const currentChainId = (): number => getSelectedChainId();
const entrypointAddr = (): string => getNetwork().entrypoint;
const NATIVE_TOKEN = NATIVE;

// --------- ABIs & interface helpers ----------
const entrypointAbi = entrypointArtifact.abi as ethers.InterfaceAbi;
const vaultAbi = nativeVaultAbiJson.abi as ethers.InterfaceAbi;
const merkleTreeAbi = merkleTreeAbiJson.abi as ethers.InterfaceAbi;
const merkleTreeInterface = new Interface(merkleTreeAbi);

// --------- getEntrypointContract ----------
export async function getEntrypointContract(
  signerOrProvider: Signer | ethers.Provider
): Promise<Contract> {

  let actor: Signer | ethers.Provider = signerOrProvider;

  // A BrowserProvider (injected wallet) must be unwrapped to a signer for writes. A plain
  // read-only Provider (e.g. JsonRpcProvider fallback) is used directly — fine for view calls.
  if (actor instanceof BrowserProvider) {
    actor = await actor.getSigner();
  }

  const address = entrypointAddr();
  // ethers v6 throws UNCONFIGURED_NAME if `address` is "" (interpreted as ENS).
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    const net = getNetwork();
    throw new Error(
      `No EVM entrypoint on ${net.name} (chain ${net.chainId}). Use Solana vault flows instead of v2 entrypoint calls.`,
    );
  }

  const contract = new Contract(
    address,
    entrypointAbi,
    actor
  );

  return contract;
}

// --------- Check Fee Payment Status ----------
export async function checkFeePaymentStatus(_nullifier: string): Promise<{ paid: boolean; amount: string | null }> {
  console.log("🔍 checkFeePaymentStatus() called for nullifier:", _nullifier.substring(0, 20) + "...");
  
  try {
    const provider = getProvider();
    if (!provider) {
      console.error("❌ Provider not found");
      return { paid: false, amount: null };
    }

    const contract = await getEntrypointContract(provider);
    const paidAmount = await contract.feePayments(_nullifier);
    
    if (paidAmount > 0n) {
      console.log("✅ Fee already paid:", paidAmount.toString());
      return { paid: true, amount: paidAmount.toString() };
    } else {
      console.log("ℹ️ No fee paid for this nullifier");
      return { paid: false, amount: null };
    }
  } catch (error: unknown) {
    const message = friendlyTxError(error);
    console.error("❌ Error checking fee payment status:", message);
    return { paid: false, amount: null };
  }
}

// --------- Deposit Implementation ----------
export async function deposit(_token: string, _amount: string) {
  console.log("deposit() called", { _token, _amount });

  const signer = getSigner();
  if (!signer) {
    console.error("Wallet not connected");
    return { success: false, error: 'Wallet not connected' };
  }

  // Level 1 Trust: Terms + proactive KYT must pass before any deposit.
  try {
    const { assertLevel1Trust } = await import('./trustLevel1');
    assertLevel1Trust(await signer.getAddress());
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  // Hard ASP: refuse deposits against soft-era entrypoints (Base mainnet cutover gate).
  try {
    const { assertHardAspLive } = await import('./hardAspLive');
    await assertHardAspLive(currentChainId());
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  const token = TOKEN_MAP[_token.toUpperCase()];
  if (!token) {
    console.error(`Token not supported: ${_token.toUpperCase()}`);
    return { success: false, error: `Token not supported: ${_token.toUpperCase()}` };
  }

  // Convert to TokenInfo format for zkHandler
  const tokenInfo: TokenInfo = {
    symbol: token.symbol,
    decimals: token.decimals,
    address: token.address
  };

  let depositId: string | null = null;
  let finalDepositId: string | null = null;

  try {
    // 1) Generate commitment data using zkHandler
    console.log("Generating commitment data...");
    const commitmentData = await generateCommitmentData(currentChainId(), tokenInfo, _amount);

    const decAmount = ethers.parseUnits(_amount, token.decimals);
    const tokenAddress = token.symbol === 'ETH' ? NATIVE_TOKEN : token.address;
    const signerAddress = await signer.getAddress();

    // Hard ASP: label = Poseidon(vaultScope, depositNonce+1); commitment nested with label.
    // Race: concurrent deposits — reconcile from Deposited event after mine if mismatch.
    const contract = await getEntrypointContract(signer);
    const vaultAddress: string = await contract.getVault(tokenAddress);
    const vault = new (await import('ethers')).Contract(
      vaultAddress,
      ["function depositNonce() view returns (uint256)"],
      signer,
    );
    const currentNonce: bigint = await vault.depositNonce();
    const nextNonce = currentNonce + 1n;
    const { hashLabel, hashCommitment, vaultScope } = await import('./noteCrypto');
    const label = await hashLabel(vaultScope(vaultAddress), nextNonce);
    const preComputedCommitment = (
      await hashCommitment(decAmount, label, BigInt(commitmentData.precommitment))
    ).toString();
    const labelStr = label.toString();

    // Compliance: Siphon ASP S_screened (+ oracle) before any deposit tx is built.
    try {
      const { assertDepositScreened } = await import('./sanctionsScreen');
      await assertDepositScreened({
        address: signerAddress,
        chainId: currentChainId(),
        commitment: preComputedCommitment,
        precommitment: commitmentData.precommitment,
        label: labelStr,
        asset: tokenAddress,
      });
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }

    const { writeNoteTyped, noteKey } = await import('./localNoteStore');
    depositId = noteKey(currentChainId(), _token, preComputedCommitment);
    await writeNoteTyped(currentChainId(), _token, {
      nullifier:     commitmentData.nullifier,
      secret:        commitmentData.secret,
      commitment:    preComputedCommitment,
      precommitment: commitmentData.precommitment,
      nullifierHash: commitmentData.nullifierHash ?? '',
      label:         labelStr,
      vaultAddress,
      amount:        _amount,
      spent:         'pending',
    }, signer);
    console.log('[deposit] pre-tx note written encrypted (label sealed in enc_blob)');

    let receipt: TransactionReceipt | null = null;

    // 2) Send transaction
    if (token.symbol === 'ETH') {
      console.log("Depositing ETH flow...");
      const tx = await contract.deposit(
        NATIVE_TOKEN,
        decAmount,
        commitmentData.precommitment,
        { value: decAmount }
      );
      console.log("Deposit tx sent (ETH):", tx.hash);
      receipt = await tx.wait();
      if (!receipt) throw new Error("Receipt is null after deposit tx");
      console.log("Deposit tx mined (ETH):", receipt.hash);
    } else {
      // ERC20 deposit: Check allowance and approve if necessary
      console.log("Signer Address:", signerAddress);
      console.log("Token Address (ERC20):", tokenAddress);

      const vaultAddress = await contract.getVault(tokenAddress);
      console.log("Vault address for token:", vaultAddress);

      let currentAllowance = await getTokenAllowance(tokenAddress, signerAddress, entrypointAddr());
      console.log(`Initial allowance for ${token.symbol} (raw): ${currentAllowance.toString()}`);
      console.log(`Initial allowance for ${token.symbol}: ${ethers.formatUnits(currentAllowance, token.decimals)}`);
      console.log(`Deposit amount (raw): ${decAmount.toString()}`);
      console.log(`Deposit amount: ${ethers.formatUnits(decAmount, token.decimals)}`);

      if (currentAllowance < decAmount) {
        // Exact-ish cap: deposit + 10% headroom (not MaxUint256). Avoids infinite spending approvals.
        const approveAmount = (decAmount * 110n) / 100n;
        console.log(
          `Insufficient allowance. Approving ${token.symbol} for Entrypoint ` +
            `(cap=${ethers.formatUnits(approveAmount, token.decimals)} = deposit+10%)...`,
        );
        try {
          const approveTx = await approveToken(tokenAddress, entrypointAddr(), approveAmount);
          console.log("Approve tx sent:", approveTx.hash);
          const approveReceipt = await approveTx.wait();
          if (!approveReceipt) throw new Error("Approve receipt is null");
          console.log("Approve tx mined:", approveReceipt.hash);

          currentAllowance = await getTokenAllowance(tokenAddress, signerAddress, entrypointAddr());
          console.log(`Allowance after approval (raw): ${currentAllowance.toString()}`);
          console.log(`Allowance after approval: ${ethers.formatUnits(currentAllowance, token.decimals)}`);

          if (currentAllowance < decAmount) {
            console.error("Allowance still insufficient after approval. This should not happen if approval was successful.");
            throw new Error("Allowance still insufficient after approval. Please check MetaMask for failed approval transactions.");
          }

        } catch (approveErr: unknown) {
          console.error("Error during token approval:", approveErr);
          throw new Error(friendlyTxError(approveErr));
        }
      } else {
        console.log("Allowance sufficient. Skipping explicit approval.");
      }

      console.log(`Proceeding with entrypoint.deposit for ${token.symbol}...`);
      const tx = await contract.deposit(tokenAddress, decAmount, commitmentData.precommitment);
      console.log("Deposit tx sent (ERC20):", tx.hash);
      receipt = await tx.wait();
      if (!receipt) throw new Error("Receipt is null after deposit tx");
      console.log("Deposit tx mined (ERC20):", receipt.hash);
    }

    // 3) Parse LeafInserted straight from the receipt — NO eth_call. The old code read getVault()
    // + merkleTree() through the injected wallet RPC purely to know the emitter address, but those
    // reads rate-limit right after a tx ("missing revert data") and threw BEFORE finalDepositId was
    // set — failing an already-mined deposit AND quarantining the note in the catch. The receipt is
    // already in hand and a deposit inserts exactly one leaf, so match the LeafInserted topic alone
    // (only the MerkleTree emits it; the tx touches only Siphon contracts).
    const LEAF_INSERTED_TOPIC = ethers.id("LeafInserted(uint256,uint256,uint256)");
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const leafLog = receipt.logs.find(
      (l): l is Log => l.topics[0] === LEAF_INSERTED_TOPIC
    );

    if (!leafLog) {
      console.error("All logs from receipt:", receipt.logs);
      throw new Error("'LeafInserted' event log not found in transaction receipt");
    }

    const [, leafBN] = abiCoder.decode(['uint256', 'uint256', 'uint256'], leafLog.data);
    const commitment = leafBN.toString();
    finalDepositId = commitment;

    // Flip the pre-written pending note to spent:'false'.
    // If on-chain commitment differs from pre-computed (shouldn't happen), write fresh.
    let depositLabel = labelStr;
    try {
      const { writeNoteTyped, markNoteSpentTyped, noteKey } = await import('./localNoteStore');
      if (commitment === preComputedCommitment) {
        // Overwrite directly — markNoteSpentTyped cannot go pending→false (rank regression)
        await writeNoteTyped(currentChainId(), _token, {
          nullifier:     commitmentData.nullifier,
          secret:        commitmentData.secret,
          commitment,
          precommitment: commitmentData.precommitment,
          nullifierHash: commitmentData.nullifierHash ?? '',
          label:         labelStr,
          vaultAddress,
          amount:        _amount,
          spent:         'false',
        }, signer);
      } else {
        // Quarantine the pre-computed entry and write the real one (parse Deposited for label).
        try {
          const { Interface } = await import('ethers');
          const iface = new Interface([
            "event Deposited(address indexed depositor, uint256 amount, uint256 commitment, uint256 precommitment, uint256 label, uint256 nonce)",
          ]);
          for (const log of receipt!.logs) {
            try {
              const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
              if (parsed?.name === "Deposited" && parsed.args.commitment.toString() === commitment) {
                depositLabel = parsed.args.label.toString();
                break;
              }
            } catch { /* not our event */ }
          }
        } catch (e) {
          console.warn('[deposit] could not parse Deposited label from receipt:', e);
        }
        markNoteSpentTyped(currentChainId(), _token, preComputedCommitment, 'true');
        await writeNoteTyped(currentChainId(), _token, {
          nullifier:     commitmentData.nullifier,
          secret:        commitmentData.secret,
          commitment,
          precommitment: commitmentData.precommitment,
          nullifierHash: commitmentData.nullifierHash ?? '',
          label:         depositLabel,
          vaultAddress,
          amount:        _amount,
          spent:         'false',
        }, signer);
        console.warn('[deposit] on-chain commitment differed from pre-computed — wrote fresh note', commitment);
      }
    } catch (e) {
      console.warn('[deposit] Failed to confirm note after tx:', e);
    }

    // Back the note up to Supabase (the durable recovery source) with write-then-verify. On failure
    // it is queued for retry, and the note's localStorage backup flag is set to 'pending' so the
    // up-sync reconcile re-attempts it — a note is never left unspent-and-unbacked-up silently.
    try {
      const { backupNoteWithConfirmation } = await import('./commitmentStore');
      const { vaultIdForAddress } = await import('./vaultRegistry');
      const vaultId = (await vaultIdForAddress(currentChainId(), _token, vaultAddress)) ?? undefined;
      const { ok } = await backupNoteWithConfirmation(
        signer,
        {
          nullifier:     commitmentData.nullifier,
          secret:        commitmentData.secret,
          commitment,
          amount:        _amount,
          chainId:       currentChainId(),
          nullifierHash: commitmentData.nullifierHash ?? '',
          precommitment: commitmentData.precommitment,
          label:         depositLabel,
          vaultAddress,
          vaultId,
        },
        _token,
        'deposit',
      );
      // Stamp the note's generation id + backup state onto its localStorage row (re-write, secrets
      // unchanged). writeNoteTyped preserves createdAt and re-seals the blob.
      try {
        const { writeNoteTyped } = await import('./localNoteStore');
        await writeNoteTyped(currentChainId(), _token, {
          nullifier:     commitmentData.nullifier,
          secret:        commitmentData.secret,
          commitment,
          precommitment: commitmentData.precommitment,
          nullifierHash: commitmentData.nullifierHash ?? '',
          label:         depositLabel,
          vaultAddress,
          vaultId,
          amount:        _amount,
          spent:         'false',
          backup:        ok ? 'confirmed' : 'pending',
        }, signer);
      } catch { /* flag stamp best-effort */ }
    } catch (e) {
      console.warn('Server commitment save failed, localStorage fallback active', e);
    }

    console.log("✅ Deposit successful!");
    invalidateLeafCache();
    notifyVaultBalanceChanged();
    // Do not log precommitment / secrets — XSS / extension scrapers.
    console.log("Deposit confirmed, commitment:", commitment.slice(0, 12) + "…");
    console.log("Transaction hash:", receipt.hash);

    // Hard ASP: postman must admit LabelMinted into the association set + publish root.
    let aspAdmitted = false;
    let aspAdmissionError: string | undefined;
    try {
      const { requestAspAdmit } = await import("./aspAdmit");
      const admit = await requestAspAdmit({
        chainId: currentChainId(),
        label: depositLabel,
        txHash: receipt.hash,
        vault: vaultAddress,
        depositor: signerAddress,
        signer,
      });
      if (!admit.ok) {
        aspAdmissionError = admit.error ?? "ASP admission is pending";
        console.warn("[deposit] ASP postman admit pending:", admit.error);
      } else {
        aspAdmitted = true;
        console.log("[deposit] ASP label admitted");
        try {
          const { clearAspClientCache } = await import("./aspClient");
          clearAspClientCache();
        } catch { /* ignore */ }
        invalidateLeafCache();
        notifyVaultBalanceChanged();
      }
    } catch (e) {
      aspAdmissionError = e instanceof Error ? e.message : "ASP admission request failed";
      console.warn("[deposit] ASP admit request failed:", e);
    }

    const { noteKey: _mkNoteKey } = await import('./localNoteStore');
    const depositNoteKey = _mkNoteKey(currentChainId(), _token, finalDepositId ?? preComputedCommitment);

    try {
      appendUserActivity(signerAddress, {
        kind: "deposit",
        chainId: currentChainId(),
        token: _token.toUpperCase(),
        amount: _amount,
        txHash: receipt.hash,
        status: "confirmed",
        label: `Deposit ${_amount} ${_token.toUpperCase()}`,
        noteKey: depositNoteKey,
      });
    } catch {
      /* activity log is best-effort */
    }

    // Auto-consolidate after a confirmed deposit when live notes exceed the 6-note circuit cap. This is
    // EXPLICITLY user-confirmed and AWAITED (not the old fire-and-forget that raced): we prompt, and only
    // if the user accepts do we run consolidateIfNeeded to completion (relayer, else MetaMask). Because it
    // fully finishes before this deposit() returns, there's no not-yet-on-chain merged note left dangling
    // for the next action to race against. Keeps withdrawals fast (notes stay <= 6). Best-effort: any
    // failure is logged and swallowed so it never blocks the deposit's success.
    try {
      // Count ASP-ADMITTED (spendable) notes — only those are mergeable (a checking note isn't in the
      // ASP tree, so a merge proof's dual-inclusion would fail). Trigger when the user already has >= 6
      // admitted notes: this fresh deposit pushes past the 6-note circuit cap, so consolidate the largest
      // 6 admitted notes now to keep future withdrawals fast.
      const { countAdmittedNotes } = await import('./zkHandler');
      const admittedCount = await countAdmittedNotes(currentChainId(), tokenInfo);
      if (admittedCount >= 6) {
        const { showAppConfirm } = await import('./appToast');
        const ok = await showAppConfirm({
          title: 'Consolidate your notes?',
          message: `You have ${admittedCount} spendable ${tokenInfo.symbol} notes. Consolidating merges your largest 6 into one so future withdrawals stay fast. This is a private on-chain merge — you'll confirm it in your wallet.`,
          confirmLabel: 'Consolidate',
          cancelLabel: 'Later',
        });
        if (ok) {
          const { consolidateIfNeeded } = await import('./noteConsolidator');
          const r = await consolidateIfNeeded(currentChainId(), tokenInfo);
          if ('error' in r) console.warn('[deposit] post-deposit consolidation failed:', r.error);
          else if (r.merged) {
            console.log('[deposit] consolidated notes after deposit');
            notifyVaultBalanceChanged();
          }
        }
      }
    } catch (e) {
      console.warn('[deposit] post-deposit consolidation skipped:', (e as Error)?.message);
    }

    // Return the canonical note key of the freshly-created note so callers (e.g. the TWAP/grid
    // split) can spend/split EXACTLY this note. finalDepositId is the on-chain commitment; the note
    // was written at noteKey(chainId, token, commitment).
    return {
      success: true,
      executeTransaction: receipt.hash,
      noteKey: depositNoteKey,
      aspAdmitted,
      aspAdmissionError,
    };

  } catch (err: unknown) {
    const message = friendlyTxError(err);
    console.error("Error during deposit:", message);
    // If the tx never mined, quarantine the pre-written pending note so it isn't
    // shown as spendable. If it did mine (finalDepositId set), leave it — it was
    // already flipped to spent:'false' above.
    if (depositId && !finalDepositId) {
      try {
        const { markNoteSpentByKey } = await import('./localNoteStore');
        markNoteSpentByKey(depositId, 'true');
      } catch { /* best-effort */ }
    }
    return { success: false, error: message };
  }
}


// --------- Withdraw Implementation ----------
export async function withdraw(
  _token: string,
  _amount: string,
  _recipient: string,
  onStatus?: (label: string | null) => void,
) {
  console.log("withdraw() called", { _token, _amount, _recipient });

  const signer = getSigner();
  if (!signer) {
    console.error("Wallet not connected");
    return { success: false, error: 'Wallet not connected' };
  }

  try {
    const { assertHardAspLive } = await import('./hardAspLive');
    await assertHardAspLive(currentChainId());
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  // Compliance: block sanctioned sender OR recipient before generating the proof.
  try {
    const { assertNotSanctioned } = await import('./sanctionsScreen');
    const chainId = currentChainId();
    await assertNotSanctioned(await signer.getAddress(), chainId);
    await assertNotSanctioned(_recipient, chainId);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  const token = TOKEN_MAP[_token.toUpperCase()];
  if (!token) {
    console.error("Token not supported for withdraw:", _token);
    return { success: false, error: `Token not supported: ${_token}` };
  }

  // Convert to TokenInfo format for zkHandler
  const tokenInfo: TokenInfo = {
    symbol: token.symbol,
    decimals: token.decimals,
    address: token.address
  };

  // Background pool refill — tops up spare precommitments before proof gen starts.
  // Not awaited; claimFromPool inside generateZKData handles an empty pool itself.
  try {
    const { ensurePool } = await import('./sparePool');
    ensurePool(signer);
  } catch { /* best-effort */ }

  try {
    // 1) Repair + sync from Supabase before building proof — fixes unreadable local copies and
    // catches cross-device spends / new notes.
    try {
      const { repairNoteSecrets } = await import('./localNoteStore');
      const repaired = await repairNoteSecrets(signer);
      if (repaired > 0) console.log(`[withdraw] repaired ${repaired} note(s) from server backup`);
    } catch (e) { console.warn('[withdraw] pre-proof note repair failed (continuing):', e); }

    // 1b) Consolidate fragmented notes so the withdrawal fits the N=6 withdraw-circuit cap. TWAP legs
    // create many tiny vault notes; without this, withdrawing a balance spread over >6 notes silently
    // exceeds the cap and hangs at "Insufficient balance". Each merge is an AWAITED on-chain tx, so the
    // merged note is on-chain before the withdraw proof — no race (unlike the disabled fire-and-forget
    // auto-merge). Runs ONLY when the largest 6 notes can't cover the amount but the vault total can.
    // A consolidation ERROR (a merge round that fails) must STOP the withdrawal with a clear
    // message — otherwise the notes still don't fit and the withdraw proof fails downstream with a
    // misleading "insufficient balance". A benign SKIP (nothing to merge, or the pre-scan throws)
    // just continues. `consolidationError` distinguishes the two.
    let consolidationError: string | null = null;
    try {
      const MAX_WITHDRAW_NOTES = 6;
      const { scanNotes } = await import('./localNoteStore');
      const amountWei = ethers.parseUnits(_amount, tokenInfo.decimals);
      const unspentWeiDesc = () => scanNotes(currentChainId(), tokenInfo.symbol)
        .filter(m => m.spent !== 'true' && m.amount)
        .map(m => { try { return ethers.parseUnits(m.amount, tokenInfo.decimals); } catch { return 0n; } })
        .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
      const sum = (arr: bigint[], n = arr.length) => arr.slice(0, n).reduce((s, a) => s + a, 0n);
      let amts = unspentWeiDesc();
      // Only bother if 6 notes can't cover it yet the whole vault can (else nothing to gain).
      if (sum(amts, MAX_WITHDRAW_NOTES) < amountWei && sum(amts) >= amountWei) {
        onStatus?.('Consolidating notes…');
        const { consolidateIfNeeded } = await import('./noteConsolidator');
        for (let round = 0; round < 12 && sum(amts, MAX_WITHDRAW_NOTES) < amountWei; round++) {
          console.log(`[withdraw] notes too fragmented for ${_amount} ${tokenInfo.symbol} — consolidating (round ${round + 1})…`);
          const r = await consolidateIfNeeded(currentChainId(), tokenInfo);
          if ('error' in r) { consolidationError = r.error; break; }
          if (!r.merged) break; // fewer than 6 unspent left — nothing more to merge
          amts = unspentWeiDesc();
        }
        onStatus?.(null);
      }
    } catch (e) {
      // The merge tx itself threw (relayer down, tx not confirmed) — treat as a real failure, not a
      // benign skip, so the user gets a retryable error instead of a confusing insufficient-balance.
      consolidationError = (e as Error)?.message || 'consolidation failed';
      onStatus?.(null);
    }
    if (consolidationError) {
      console.warn('[withdraw] consolidation failed:', consolidationError);
      return { success: false, error: 'Could not consolidate notes for this withdrawal — please retry.' };
    }

    // 2) Generate ZK data using zkHandler
    console.log("Generating ZK data for withdrawal...");
    let zkDataResult = await generateZKData(currentChainId(), tokenInfo, _amount, _recipient);

    // No spendable note found locally? May be a vault-output note not yet resolved.
    // Resolve pending output notes (writes secrets from precommitment), then retry once.
    if ('error' in zkDataResult && /insufficient balance|secrets aren't on this device|metadata-only|out of sync/i.test(zkDataResult.error)) {
      try {
        const { repairNoteSecrets } = await import('./localNoteStore');
        const repaired = await repairNoteSecrets(signer);
        if (repaired > 0) console.log(`[withdraw] second-pass repaired ${repaired} note(s) from server`);
        const { resolvePendingOutputNotes } = await import('./outputNoteResolver');
        const r = await resolvePendingOutputNotes(signer);
        if (r > 0) console.log(`[withdraw] resolved ${r} pending output note(s)`);
        zkDataResult = await generateZKData(currentChainId(), tokenInfo, _amount, _recipient);
      } catch (e) {
        console.warn('[withdraw] output-note resolve + retry failed:', e);
      }
    }

    if ('error' in zkDataResult) {
      return { success: false, error: zkDataResult.error };
    }

    const zkData = zkDataResult;
    const withdrawalTxData = zkData.withdrawalTxData;

    console.log("ZK data generated successfully");

    const tokenAddress = token.symbol === 'ETH' ? NATIVE_TOKEN : token.address;
    const entrypoint = await getEntrypointContract(signer);
    const withdrawFn = entrypoint.getFunction('withdraw');

    // _depositor / _changeValue back the change note's DepositInfo so the user retains
    // revocation + ragequit authority over it. _depositor is the note owner (the connected
    // wallet), NOT _recipient (the fresh, unlinked withdrawal address). _changeValue is the
    // circuit-bound change amount (inSum − withdrawnValue).
    const changeDepositor = await signer.getAddress();
    const changeValueStr = zkData.changeValue.toString();

    // 2) Dry-run with staticCall using multi-note calldata
    try {
      console.log("Performing withdraw.staticCall (dry-run)...");
      await withdrawFn.staticCall(
        tokenAddress,
        _recipient,
        changeDepositor,
        changeValueStr,
        withdrawalTxData.amount.toString(),
        withdrawalTxData.stateRoot,
        withdrawalTxData.aspRoot,
        withdrawalTxData.nullifierHashes,
        withdrawalTxData.changeCommitment,
        withdrawalTxData.changeLabel,
        withdrawalTxData.pA,
        withdrawalTxData.pB,
        withdrawalTxData.pC
      );
      console.log("withdraw.staticCall succeeded - proof validated on-chain (dry-run).");
    } catch (err: unknown) {
      const message = friendlyTxError(err);
      console.error("withdraw.staticCall reverted:", message);
      return { success: false, error: message };
    }

    // Pre-tx change note: write it encrypted as spent:'pending' before submitting.
    // changeCommitment is already known (circuit input), so we can write the full
    // encrypted note now — no plaintext hint needed. On confirm → flip to 'false'.
    // On revert → flip to 'true' (quarantined). Crash-safe: note survives page refresh.
    if (zkData.changeValue > 0n && zkData.newDeposit?.commitment) {
      try {
        const { writeNoteTyped: _wn } = await import('./localNoteStore');
        await _wn(currentChainId(), token.symbol, {
          nullifier:     zkData.newDeposit.nullifier,
          secret:        zkData.newDeposit.secret,
          commitment:    zkData.newDeposit.commitment,
          precommitment: zkData.newDeposit.precommitment ?? '',
          nullifierHash: zkData.newDeposit.nullifierHash ?? '',
          label:         zkData.newDeposit.label,
          amount:        zkData.newDeposit.amount,
          spent:         'pending',
        }, signer);
      } catch (e) { console.warn('[withdraw] pre-tx change note write failed:', e); }
    }

    // 3) Submit the withdrawal via the RELAYER — not the user's wallet.
    // The proof is already bound to the proof-locked recipient and to the fee-inclusive gross
    // `amount`, so the executor hot wallet can submit Entrypoint.withdraw() verbatim. Result:
    // no MetaMask popup, and the withdrawer's own address never appears on-chain (tx `From` is
    // the relayer). Funds are NOT custodied — the vault sends directly vault→recipient, and the
    // on-chain fee's gasReimburse leg refunds the relayer's gas. The staticCall dry-run above
    // already validated the proof locally, so a relayer failure here is transport/liveness only.
    const quarantinePendingChange = async () => {
      if (zkData.changeValue > 0n && zkData.newDeposit?.commitment) {
        try {
          const { markNoteSpentTyped } = await import('./localNoteStore');
          markNoteSpentTyped(currentChainId(), token.symbol, zkData.newDeposit.commitment, 'true');
        } catch { /* best-effort */ }
      }
      if (zkData.changePoolId) {
        try {
          const { releasePrecommitment } = await import('./precommitmentStore');
          await releasePrecommitment(signer, zkData.changePoolId);
        } catch { /* best-effort */ }
      }
    };

    const submitViaWallet = async (): Promise<string> => {
      console.log('[withdraw] submitting via connected wallet (relayer fallback)…');
      const tx = await withdrawFn(
        tokenAddress,
        _recipient,
        changeDepositor,
        changeValueStr,
        withdrawalTxData.amount.toString(),
        withdrawalTxData.stateRoot,
        withdrawalTxData.aspRoot,
        withdrawalTxData.nullifierHashes,
        withdrawalTxData.changeCommitment,
        withdrawalTxData.changeLabel,
        withdrawalTxData.pA,
        withdrawalTxData.pB,
        withdrawalTxData.pC,
      );
      const receipt = await tx.wait();
      if (!receipt?.hash) throw new Error('wallet withdraw returned no transaction hash');
      return receipt.hash;
    };

    let txHash: string | undefined;
    try {
      console.log("Submitting withdraw via relayer...");
      onStatus?.('Submitting withdrawal…');
      const { getTradeExecutorBaseUrl } = await import('./tradeExecutorClient');
      // /relayWithdraw is write-challenge gated on the executor — attach a fresh wallet write
      // signature (X-Write-Signature / X-Write-Nonce) so the relayer withdrawal can't be triggered
      // anonymously. The recipient stays proof-bound; this only authenticates the submitter.
      const writeHeaders = await getWalletWriteAuthHeaders(signer);

      const resp = await fetchWithTimeout(
        `${getTradeExecutorBaseUrl()}/relayWithdraw`,
        {
          method: 'POST',
          headers: writeHeaders,
          body: JSON.stringify({
            chain_id: currentChainId(),
            asset: token.symbol,
            recipient: _recipient,
            amount: withdrawalTxData.amount.toString(),
            // Change note DepositInfo: the note owner (this wallet, NOT the proof-bound recipient)
            // and the circuit-bound change value. The executor forwards both into Entrypoint.withdraw
            // so the change note is revocable + ragequittable by the user.
            depositor: changeDepositor,
            changeValue: changeValueStr,
            proof: {
              stateRoot:        withdrawalTxData.stateRoot.toString(),
              aspRoot:          withdrawalTxData.aspRoot.toString(),
              changeLabel:      withdrawalTxData.changeLabel.toString(),
              changeValue:      changeValueStr,
              nullifierHashes:  withdrawalTxData.nullifierHashes.map((h: unknown) => h!.toString()),
              changeCommitment: withdrawalTxData.changeCommitment.toString(),
              publicSignals:    withdrawalTxData.publicSignals,
              pA: withdrawalTxData.pA.map((x: unknown) => x!.toString()),
              pB: withdrawalTxData.pB.map((row: unknown[]) => row.map((x) => x!.toString())),
              pC: withdrawalTxData.pC.map((x: unknown) => x!.toString()),
            },
          }),
        },
        RELAY_WITHDRAW_TIMEOUT_MS,
      );
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = body?.error || `relayer returned ${resp.status}`;
        console.error("relayWithdraw failed:", msg);
        // Treat all relayer failures as transport-like so we fall through to wallet submit.
        // The remote relayer may lag contract upgrades (e.g. v4 → v5 proof format mismatch).
        throw new Error(msg);
      }
      txHash = body?.tx_hash;
      if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        console.error("relayWithdraw returned no/invalid tx hash:", txHash);
        await quarantinePendingChange();
        return { success: false, error: 'relayer returned no valid transaction hash' };
      }
      console.log("Withdraw relayed, tx:", txHash);
    } catch (relayerErr: unknown) {
      const relayMsg = friendlyTxError(relayerErr);
      console.warn('[withdraw] relayer failed — falling back to wallet submit:', relayMsg);
      onStatus?.('Confirm in wallet…');
      try {
        txHash = await submitViaWallet();
        console.log('[withdraw] wallet fallback confirmed, tx:', txHash);
      } catch (walletErr: unknown) {
        const message = friendlyTxError(walletErr);
        console.error('[withdraw] wallet fallback failed:', message);
        await quarantinePendingChange();
        return { success: false, error: `Relayer unavailable and wallet submit failed: ${message}` };
      }
    }

    if (!txHash) {
      await quarantinePendingChange();
      return { success: false, error: 'withdraw did not produce a transaction hash' };
    }

    try {
      try {
        const { markNoteSpentByKey } = await import('./localNoteStore');
        const { markCommitmentSpent, markCommitmentSpentByCommitment } = await import('./commitmentStore');
        for (const key of zkData.spentDepositKeys) {
          markNoteSpentByKey(key);
          const serverId = zkData.serverCommitmentIds[key];
          if (serverId) {
            markCommitmentSpent(signer, serverId, 'true').catch(e =>
              console.warn('Failed to mark server commitment spent:', key, e)
            );
          } else {
            const parts = key.split('-');
            const commitment = key.startsWith('siphon-note-') ? parts.slice(4).join('-') : parts.slice(2).join('-');
            if (commitment) {
              markCommitmentSpentByCommitment(signer, commitment)
                .then(n => n > 0 && console.log(`[withdraw] marked ${n} Supabase commitment(s) spent by value for`, key))
                .catch(e => console.warn('Failed to mark server commitment spent by value:', key, e));
            }
          }
        }
        try {
          const { writeNullifier } = await import('./nullifierStore');
          for (const nullifierHash of zkData.withdrawalTxData.nullifierHashes) {
            writeNullifier(signer, nullifierHash)
              .catch(e => console.warn('[nullifier-registry] Insert failed (non-blocking):', e));
          }
        } catch { /* best-effort */ }
      } catch {
        console.warn("Failed to mark local deposits spent");
      }

      // 5) Confirm change note only when changeValue > 0.
      // Zero-value change notes are on-chain (circuit always inserts a leaf) but have no
      // spendable value — no point tracking them in localStorage or the commitments table.
      if (zkData.changeValue > 0n && zkData.newDeposit?.commitment) {
        // Flip the pre-written pending note to spent:'false' — it's now confirmed on-chain.
        // Must use writeNoteTyped directly — markNoteSpentTyped cannot go pending→false (rank regression).
        try {
          const { writeNoteTyped: _wnConfirm } = await import('./localNoteStore');
          await _wnConfirm(currentChainId(), token.symbol, {
            nullifier:     zkData.newDeposit.nullifier,
            secret:        zkData.newDeposit.secret,
            commitment:    zkData.newDeposit.commitment,
            precommitment: zkData.newDeposit.precommitment ?? '',
            nullifierHash: zkData.newDeposit.nullifierHash ?? '',
            label:         zkData.newDeposit.label,
            amount:        zkData.newDeposit.amount,
            spent:         'false',
          }, signer);
        } catch (e) {
          console.warn('[withdraw] Failed to confirm change note:', e);
        }
        console.log('[withdraw] change note confirmed:', zkData.newDeposit.commitment);

        // Back the change note up to Supabase with write-then-verify. The change note is minted into
        // the CURRENT vault, so its generation is currentVaultId. On failure it is queued + flagged
        // backup:'pending' so the up-sync reconcile re-attempts it.
        try {
          const { backupNoteWithConfirmation } = await import('./commitmentStore');
          const { currentVaultId } = await import('./vaultRegistry');
          const changeVaultId = (await currentVaultId(currentChainId(), token.symbol)) ?? undefined;
          const { ok } = await backupNoteWithConfirmation(
            signer,
            {
              nullifier:     zkData.newDeposit.nullifier,
              secret:        zkData.newDeposit.secret,
              commitment:    zkData.newDeposit.commitment!,
              amount:        zkData.newDeposit.amount,
              chainId:       currentChainId(),
              nullifierHash: zkData.newDeposit.nullifierHash ?? '',
              precommitment: zkData.newDeposit.precommitment,
              label:         zkData.newDeposit.label,
              vaultId:       changeVaultId,
            },
            token.symbol,
            'change',
          );
          try {
            const { markNoteBackupConfirmed, writeNoteTyped: _wnFlag } = await import('./localNoteStore');
            if (ok) {
              await markNoteBackupConfirmed(currentChainId(), token.symbol, zkData.newDeposit.commitment!);
            } else {
              // stamp vaultId + pending flag onto the note
              await _wnFlag(currentChainId(), token.symbol, {
                nullifier:     zkData.newDeposit.nullifier,
                secret:        zkData.newDeposit.secret,
                commitment:    zkData.newDeposit.commitment!,
                precommitment: zkData.newDeposit.precommitment ?? '',
                nullifierHash: zkData.newDeposit.nullifierHash ?? '',
                label:         zkData.newDeposit.label,
                vaultId:       changeVaultId,
                amount:        zkData.newDeposit.amount,
                spent:         'false',
                backup:        'pending',
              }, signer);
            }
          } catch { /* flag stamp best-effort */ }
        } catch (e) {
          console.warn('Change note server save failed, localStorage fallback active', e);
        }
      }

      // Resolve the pool precommitment now that the change note is confirmed on-chain.
      if (zkData.changePoolId) {
        try {
          const { resolvePrecommitment } = await import('./precommitmentStore');
          await resolvePrecommitment(signer, zkData.changePoolId);
        } catch (e) {
          console.warn('[pool] Failed to resolve pool precommitment:', e);
        }
        // Refill pool async so the next withdrawal has entries ready.
        try {
          const { ensurePool } = await import('./sparePool');
          ensurePool(signer);
        } catch { /* best-effort */ }
      }

      // Invalidate the leaf cache so the next withdrawal/balance refresh sees the
      // updated tree: spent leaves gone, change leaf added.
      invalidateLeafCache();
      notifyVaultBalanceChanged();

      try {
        const wallet = await signer.getAddress();
        appendUserActivity(wallet, {
          kind: "withdraw",
          chainId: currentChainId(),
          token: _token.toUpperCase(),
          amount: _amount,
          txHash: txHash,
          status: "confirmed",
          label: `Withdraw ${_amount} ${_token.toUpperCase()}`,
        });
      } catch {
        /* activity log is best-effort */
      }

      return { success: true, transactionHash: txHash };
    } catch (err: unknown) {
      const message = friendlyTxError(err);
      console.error("Error during withdraw transaction:", message);
      // Quarantine the pre-written change note (tx reverted — note is not on-chain).
      if (zkData.changeValue > 0n && zkData.newDeposit?.commitment) {
        try {
          const { markNoteSpentTyped } = await import('./localNoteStore');
          markNoteSpentTyped(currentChainId(), token.symbol, zkData.newDeposit.commitment, 'true');
        } catch { /* best-effort */ }
      }
      // Release pool entry so it can be reused by the next withdrawal attempt.
      if (zkData.changePoolId) {
        try {
          const { releasePrecommitment } = await import('./precommitmentStore');
          await releasePrecommitment(signer, zkData.changePoolId);
        } catch { /* best-effort */ }
      }
      return { success: false, error: message };
    }
  } catch (err: unknown) {
    const message = friendlyTxError(err);
    console.error("Error during withdraw:", message);
    return { success: false, error: message };
  }
}

/**
 * Ragequit a Pending/Revoked Hard ASP deposit back to the original depositor.
 * `_noteKey` is the local note key (siphon-note-…).
 */
/**
 * One exit at a time, across every caller.
 *
 * The dashboard offers three exits — the balance card's per-note Ragequit, the Activity Log's
 * per-row Ragequit, and Ragequit all / Recover all — living in two components with two independent
 * busy flags. Pressing them together started three concurrent exits over the same notes. The
 * nullifier set makes a double spend impossible, so funds were never at risk, but the losers waste
 * a full proof and surface as NullifierAlreadyUsed after the fact.
 *
 * The guard belongs here rather than in either component: this is the choke point every exit
 * already routes through, and a per-component flag cannot see the other component.
 */
let exitInFlight = false;

function beginExit(): { ok: false; error: string } | null {
  if (exitInFlight) {
    return { ok: false, error: "Another exit is already running — wait for it to finish." };
  }
  exitInFlight = true;
  return null;
}

export async function ragequit(_token: string, _noteKey: string) {
  const busy = beginExit();
  if (busy) return { success: false, error: busy.error };
  try {
    return await ragequitInner(_token, _noteKey);
  } finally {
    exitInFlight = false;
  }
}

async function ragequitInner(_token: string, _noteKey: string) {
  const signer = getSigner();
  if (!signer) return { success: false, error: "Wallet not connected" };

  // v3 notes ragequit through the kernel's ACTION_RAGEQUIT, not the legacy Entrypoint. Dispatch
  // before the v1 liveness gate below, which asks about a Hard ASP deployment v3 does not have.
  // Funds are returned to the depositor, which for a v3 note is necessarily the connected wallet
  // (only its owner can decrypt it).
  const rqChainId = currentChainId();
  const { v3Deployed: _v3Deployed } = await import("./v3/configV3");
  if (_v3Deployed(rqChainId)) {
    try {
      const { ragequitByNoteKeyV3 } = await import("./v3/spendRouterV3");
      const to = await signer.getAddress();
      const res = await ragequitByNoteKeyV3({ noteKey: _noteKey, recipient: to, signer });
      invalidateLeafCache();
      notifyVaultBalanceChanged();
      const { formatUnits } = await import("ethers");
      const rqAmount = formatUnits(res.value, TOKEN_MAP[_token.toUpperCase()]?.decimals ?? 18);
      try {
        markUserActivityRagequit(to, _noteKey, {
          label: `Ragequit ${rqAmount} ${_token.toUpperCase()}`,
          ragequitTxHash: res.txHash,
          amount: rqAmount,
          token: _token.toUpperCase(),
          chainId: rqChainId,
        });
      } catch { /* activity log is best-effort */ }
      return { success: true, transactionHash: res.txHash };
    } catch (err: unknown) {
      return { success: false, error: friendlyTxError(err, "ragequit") };
    }
  }

  try {
    const { assertHardAspLive } = await import("./hardAspLive");
    await assertHardAspLive(currentChainId());
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  const token = TOKEN_MAP[_token.toUpperCase()];
  if (!token) return { success: false, error: `Token not supported: ${_token}` };

  const tokenInfo: TokenInfo = {
    symbol: token.symbol,
    decimals: token.decimals,
    address: token.address,
  };

  try {
    const proof = await generateRagequitProof(currentChainId(), tokenInfo, _noteKey);
    if ("error" in proof) return { success: false, error: proof.error };

    const contract = await getEntrypointContract(signer);
    const tx = await contract.ragequit(
      proof.asset,
      BigInt(proof.label),
      BigInt(proof.stateRoot),
      BigInt(proof.nullifierHash),
      proof.pA,
      proof.pB,
      proof.pC,
    );
    const receipt = await tx.wait();
    try {
      const { markNoteSpent } = await import("./localNoteStore");
      markNoteSpent(proof.spentDepositKey);
    } catch { /* best-effort */ }
    invalidateLeafCache();
    notifyVaultBalanceChanged();
    try {
      const addr = await signer.getAddress();
      markUserActivityRagequit(addr, _noteKey, {
        label: `Ragequit ${proof.amount} ${_token.toUpperCase()}`,
        ragequitTxHash: receipt?.hash ?? tx.hash,
        amount: proof.amount,
        token: _token.toUpperCase(),
        chainId: currentChainId(),
      });
    } catch { /* activity log is best-effort */ }
    return { success: true, transactionHash: receipt?.hash ?? tx.hash };
  } catch (err: unknown) {
    return { success: false, error: friendlyTxError(err, "ragequit") };
  }
}

export type RagequitCandidate = {
  noteKey: string;
  token: string;
  amount: string;
  status: "pending" | "revoked";
};

export type DepositScreening = {
  noteKey: string;
  token: string;
  amount: string;
  /** Pending and not yet in the association set = checking. Revoked = flagged. */
  phase: "checking" | "flagged";
  /** True when the ASP HAS admitted this note and it is therefore spendable right now.
   *
   * A `checking` row can be either of two very different things, and conflating them is what made
   * a 2.99 USDC balance render as 0.01: a note that is genuinely not admitted yet, or one that IS
   * admitted but is still inside its five-minute ragequit window (so the public exit is offered).
   * Only the first is unspendable. Anything that subtracts from the spendable headline, or refuses
   * a spend, must read THIS — never `phase` alone. */
  admitted?: boolean;
  /** Original deposit leaf (per-row ragequit). Change notes recover via ragequitBatch. */
  isOriginal: boolean;
  /** The DepositInfo depositor — the wallet a ragequit of this note returns funds to. Always the
   * connected wallet here (rows are filtered to `me`), surfaced so the UI can attribute/group the
   * ragequit balance by depositor address. */
  depositor: string;
  /** Browser display deadline; the API independently enforces this from the deposit block. */
  graceDeadlineMs?: number;
  /** Not admitted yet: when the next ASP bus leaves (aspBusV3.nextBusAtMs). */
  busEtaMs?: number;
};

/**
 * Local unspent notes that are not privately spendable yet.
 * On-chain Pending is normal after a deposit; it leaves this list once the
 * association set contains the label (watcher admit). Revoked stays flagged.
 * Pass `includeChangeNotes` so rejected change notes appear for recover-all.
 */
export async function listDepositScreening(
  _token: string,
  opts?: { includeChangeNotes?: boolean },
): Promise<DepositScreening[]> {
  const signer = getSigner();
  if (!signer || typeof window === "undefined") return [];

  const token = TOKEN_MAP[_token.toUpperCase()];
  if (!token) return [];

  const chainId = currentChainId();

  // v3 chains cannot use the scan below at all: their notes are stored under the
  // `siphon-v3note-` prefix, there is no per-label DepositInfo on the kernel, and admission moved
  // from the v1 association set to the ASP bus. Silently returning nothing here is what hid the
  // "in checking" / "flagged" rows — and the ragequit controls they drive — on Base and Sepolia.
  const { v3Deployed } = await import("./v3/configV3");
  if (v3Deployed(chainId)) {
    const { listDepositScreeningV3 } = await import("./v3/depositScreeningV3");
    return listDepositScreeningV3(chainId, token.symbol, signer, opts);
  }

  const tokenAddress = token.symbol === "ETH" ? NATIVE_TOKEN : token.address;
  const prefix = `siphon-note-${chainId}-${token.symbol.toUpperCase()}-`;

  let vault: Contract;
  try {
    ({ vault } = await resolveVault(tokenAddress, chainId));
  } catch {
    return [];
  }

  const { readDepositInfo, isOriginalDepositNote, classifyAspNote } = await import("./depositLabel");
  const { labelInAssociationSet } = await import("./aspProof");
  const { poseidon1 } = await import("./noteCrypto");
  const me = (await signer.getAddress()).toLowerCase();
  const includeChange = Boolean(opts?.includeChangeNotes);

  const { readNote } = await import("./localNoteStore");
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }

  const out: DepositScreening[] = [];
  for (const key of keys) {
    try {
      const data = await readNote(key, signer);
      if (!data || data.spent === "true") continue;
      const label = String(data.label || "").trim();
      if (!label || label === "0" || !data.commitment) continue;
      const info = await readDepositInfo(vault, label);
      if (!info) continue;
      if (info.depositor.toLowerCase() !== me) continue;
      const isOriginal = isOriginalDepositNote(data.commitment, info);
      if (!isOriginal && !includeChange) continue;
      const inAsp = await labelInAssociationSet(label);
      const access = classifyAspNote(info.status, inAsp);
      if (access !== "checking" && access !== "flagged") continue;
      if (data.nullifier) {
        try {
          const nh = await poseidon1(BigInt(data.nullifier));
          if (await vault.nullifiers(nh)) continue;
        } catch { /* still list — local spent flag is the fallback */ }
      }
      out.push({
        noteKey: key,
        token: token.symbol,
        amount: String(data.amount),
        phase: access,
        isOriginal,
        depositor: info.depositor,
      });
    } catch {
      /* skip undecryptable / RPC miss */
    }
  }
  return out;
}

/** Live checking/flagged totals — same source of truth as Activity Log screening overlay. */
export async function aggregateDepositScreeningTotals(): Promise<{
  checking: Record<string, number>;
  flagged: Record<string, number>;
}> {
  const checking: Record<string, number> = {};
  const flagged: Record<string, number> = {};
  for (const sym of ["ETH", "USDC"]) {
    const rows = await listDepositScreening(sym, { includeChangeNotes: true });
    for (const r of rows) {
      const amt = parseFloat(r.amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      if (r.phase === "checking") checking[sym] = (checking[sym] ?? 0) + amt;
      else flagged[sym] = (flagged[sym] ?? 0) + amt;
    }
  }
  return { checking, flagged };
}

/**
 * The connected wallet's flagged (revoked) ragequit balance, per token. Ragequit is batch-only — all
 * flagged (dirty) funds are recovered at once; we never leave revoked value shielded. Only the connected
 * wallet's own notes are counted (listDepositScreening scopes to the depositor + only decryptable notes
 * surface), so this is exactly what "Ragequit all" will recover to this wallet.
 */
export async function flaggedRagequitBalance(
  tokens: string[] = ["ETH", "USDC"],
): Promise<Record<string, number>> {
  const amountByToken: Record<string, number> = {};
  for (const sym of tokens) {
    const rows = await listDepositScreening(sym, { includeChangeNotes: true });
    for (const r of rows) {
      if (r.phase !== "flagged") continue; // ragequit surface = revoked/flagged notes only
      const amt = parseFloat(r.amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      amountByToken[sym] = (amountByToken[sym] ?? 0) + amt;
    }
  }
  return amountByToken;
}

export type PrivateWithdrawCap = {
  /** Max withdraw in one tx (total admitted, up to 6-note circuit cap). */
  maxSingleWithdraw: string;
  /** Total ASP-admitted balance across all labels. */
  totalAdmitted: string;
  /** Number of distinct deposit associations with spendable balance. */
  labelGroupCount: number;
};

/**
 * Hard ASP withdraw can only spend notes from one deposit label per transaction.
 * Use this to pre-validate amounts and explain multi-deposit limits in the UI.
 */
export async function getPrivateWithdrawCap(_token: string): Promise<PrivateWithdrawCap | null> {
  const signer = getSigner();
  if (!signer || typeof window === "undefined") return null;

  const token = TOKEN_MAP[_token.toUpperCase()];
  if (!token) return null;

  const chainId = currentChainId();
  const tokenAddress = token.symbol === "ETH" ? NATIVE_TOKEN : token.address;
  const prefix = `siphon-note-${chainId}-${token.symbol.toUpperCase()}-`;

  let vault: Contract;
  try {
    ({ vault } = await resolveVault(tokenAddress, chainId));
  } catch {
    return null;
  }

  const { readDepositInfo, classifyAspNote } = await import("./depositLabel");
  const { labelInAssociationSet } = await import("./aspProof");
  const { poseidon1 } = await import("./noteCrypto");
  const { readNote } = await import("./localNoteStore");
  const me = (await signer.getAddress()).toLowerCase();

  const byLabel = new Map<string, bigint>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const data = await readNote(key, signer);
      if (!data || data.spent === "true") continue;
      const label = String(data.label || "").trim();
      if (!label || label === "0" || !data.commitment) continue;
      const info = await readDepositInfo(vault, label);
      if (!info || info.depositor.toLowerCase() !== me) continue;
      const inAsp = await labelInAssociationSet(label);
      const access = classifyAspNote(info.status, inAsp);
      if (access !== "deposited") continue;
      if (data.nullifier) {
        try {
          const nh = await poseidon1(BigInt(data.nullifier));
          if (await vault.nullifiers(nh)) continue;
        } catch { /* treat as unspent */ }
      }
      const { toAmountString } = await import("./amountString");
      const amt = ethers.parseUnits(toAmountString(data.amount as string | number, token.decimals), token.decimals);
      byLabel.set(label, (byLabel.get(label) ?? 0n) + amt);
    } catch {
      /* skip undecryptable */
    }
  }

  if (byLabel.size === 0) return null;

  let totalWei = 0n;
  for (const sum of byLabel.values()) {
    totalWei += sum;
  }

  return {
    maxSingleWithdraw: ethers.formatUnits(totalWei, token.decimals),
    totalAdmitted: ethers.formatUnits(totalWei, token.decimals),
    labelGroupCount: byLabel.size,
  };
}

/** @deprecated use listDepositScreening — flagged rows only */
export async function listRagequitCandidates(_token: string): Promise<RagequitCandidate[]> {
  const rows = await listDepositScreening(_token);
  return rows
    .filter((r) => r.phase === "flagged")
    .map((r) => ({
      noteKey: r.noteKey,
      token: r.token,
      amount: r.amount,
      status: "revoked" as const,
    }));
}

export type RecoverAllRejectedResult = {
  success: boolean;
  recovered: number;
  skipped: number;
  failedProofs: number;
  transactionHashes: string[];
  error?: string;
};

const RECOVER_TOKENS = ["ETH", "USDC"] as const;

/**
 * One-click recover of all Pending/Revoked notes (original + change) via ragequitBatch.
 * Marks a note spent locally only after `vault.nullifiers(nh)` confirms the spend.
 */
export async function recoverAllRejected(
  opts?: { flaggedOnly?: boolean },
): Promise<RecoverAllRejectedResult> {
  const busy = beginExit();
  if (busy) {
    return { success: false, recovered: 0, skipped: 0, failedProofs: 0, transactionHashes: [], error: busy.error };
  }
  try {
    return await recoverAllRejectedInner(opts);
  } finally {
    exitInFlight = false;
  }
}

async function recoverAllRejectedInner(
  opts?: { flaggedOnly?: boolean },
): Promise<RecoverAllRejectedResult> {
  const signer = getSigner();
  if (!signer) return { success: false, recovered: 0, skipped: 0, failedProofs: 0, transactionHashes: [], error: "Wallet not connected" };

  try {
    const { assertHardAspLive } = await import("./hardAspLive");
    await assertHardAspLive(currentChainId());
  } catch (e) {
    return { success: false, recovered: 0, skipped: 0, failedProofs: 0, transactionHashes: [], error: (e as Error).message };
  }

  const empty: RecoverAllRejectedResult = { success: true, recovered: 0, skipped: 0, failedProofs: 0, transactionHashes: [] };
  const [eth, usdc] = await Promise.all([
    listDepositScreening("ETH", { includeChangeNotes: true }),
    listDepositScreening("USDC", { includeChangeNotes: true }),
  ]);
  // flaggedOnly: batch ONLY revoked/flagged notes (the dirty funds). This is the canonical "Ragequit All"
  // path — checking notes are left to become spendable normally. listDepositScreening already scopes to
  // the connected wallet, so this only touches notes the connected wallet can actually ragequit.
  const flaggedOnly = Boolean(opts?.flaggedOnly);
  const byToken = new Map<string, DepositScreening[]>();
  for (const row of [...eth, ...usdc]) {
    if (flaggedOnly && row.phase !== "flagged") continue;
    const list = byToken.get(row.token) ?? [];
    list.push(row);
    byToken.set(row.token, list);
  }
  if (byToken.size === 0) {
    return { ...empty, error: "No rejected notes to recover." };
  }

  const contract = await getEntrypointContract(signer);
  const { markNoteSpent } = await import("./localNoteStore");
  const addr = await signer.getAddress();
  const chainId = currentChainId();

  let recovered = 0;
  let skipped = 0;
  let failedProofs = 0;
  const transactionHashes: string[] = [];
  const errors: string[] = [];

  for (const symbol of RECOVER_TOKENS) {
    const rows = byToken.get(symbol);
    if (!rows?.length) continue;
    const token = TOKEN_MAP[symbol];
    if (!token) continue;

    const tokenInfo: TokenInfo = {
      symbol: token.symbol,
      decimals: token.decimals,
      address: token.address,
    };
    const tokenAddress = token.symbol === "ETH" ? NATIVE_TOKEN : token.address;

    type Prepared = {
      noteKey: string;
      amount: string;
      nullifierHash: string;
      arg: {
        label: bigint;
        stateRoot: bigint;
        nullifierHash: bigint;
        amount: bigint;
        commitment: bigint;
        pA: string[];
        pB: string[][];
        pC: string[];
      };
    };
    const prepared: Prepared[] = [];
    for (const row of rows) {
      const proof = await generateRagequitProof(chainId, tokenInfo, row.noteKey, { allowChangeNotes: true });
      if ("error" in proof) {
        failedProofs += 1;
        skipped += 1;
        continue;
      }
      prepared.push({
        noteKey: row.noteKey,
        amount: proof.amount,
        nullifierHash: proof.nullifierHash,
        arg: {
          label: BigInt(proof.label),
          stateRoot: BigInt(proof.stateRoot),
          nullifierHash: BigInt(proof.nullifierHash),
          amount: BigInt(proof.amountWei),
          commitment: BigInt(proof.commitment),
          pA: proof.pA,
          pB: proof.pB,
          pC: proof.pC,
        },
      });
    }
    if (prepared.length === 0) continue;

    let vault: Contract;
    try {
      ({ vault } = await resolveVault(tokenAddress, chainId));
    } catch (err) {
      errors.push(friendlyTxError(err, "ragequit"));
      skipped += prepared.length;
      continue;
    }

    for (const chunk of chunkRagequitItems(prepared)) {
      try {
        const tx = await contract.ragequitBatch(tokenAddress, chunk.map((p) => p.arg));
        const receipt = await tx.wait();
        const txHash = receipt?.hash ?? tx.hash;
        transactionHashes.push(txHash);

        const { spentKeys, unspentKeys } = await markRagequitNotesFromChain(
          { nullifiers: (nh) => vault.getFunction("nullifiers")(nh) },
          chunk.map((p) => ({ noteKey: p.noteKey, nullifierHash: p.nullifierHash })),
          (key) => markNoteSpent(key),
        );
        recovered += spentKeys.length;
        skipped += unspentKeys.length;

        const spentSet = new Set(spentKeys);
        for (const p of chunk) {
          if (!spentSet.has(p.noteKey)) continue;
          try {
            markUserActivityRagequit(addr, p.noteKey, {
              label: `Ragequit ${p.amount} ${symbol}`,
              ragequitTxHash: txHash,
              amount: p.amount,
              token: symbol,
              chainId,
            });
          } catch { /* activity log is best-effort */ }
        }
      } catch (err: unknown) {
        errors.push(friendlyTxError(err, "ragequit"));
        skipped += chunk.length;
      }
    }
  }

  invalidateLeafCache();
  notifyVaultBalanceChanged();

  if (recovered === 0 && transactionHashes.length === 0) {
    return {
      success: false,
      recovered,
      skipped,
      failedProofs,
      transactionHashes,
      error: errors[0] || "Recovery did not spend any notes.",
    };
  }
  return {
    success: true,
    recovered,
    skipped,
    failedProofs,
    transactionHashes,
    error: errors[0],
  };
}

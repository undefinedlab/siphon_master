/**
 * v3 deposit flow (Phase 2 / Gap 5 — O-23 amount-bound deposit).
 *
 * depositV3({chainId, token, amount, signer}):
 * 1. requireV3(chainId) (fail closed if not deployed).
 * 2. Generate nullifier, secret (CSPRNG), userSalt = randomUserSalt().
 * 3. precommitment = hashPrecommitment(nullifier, secret).
 * 4. Get depositNonce from VaultKernel.
 * 5. label = deriveDepositLabel({chainId, vaultAddress: vaultKernel, depositNonce, userSalt}).
 * 6. assetId = assetIdFromToken(token); commitment = hashCommitment(amount, label, assetId, nullifier, secret).
 * 7. Screen depositor via assertDepositScreened BEFORE tx.
 * 8. Native ETH -> VaultKernel.depositNative{value}(userSalt, precommitment) (kernel wraps to WETH).
 * 8b. ERC-20 -> approve the ASSET ADAPTER, then VaultKernel.deposit(token, amount, userSalt, pre).
 * 9. On success: saveV3Note(chainId, {...}). userSalt is stored in note (for label derivation)
 *    but NEVER sent on-chain/logged beyond the deposit call parameter.
 */

import { Contract, formatUnits, Signer } from "ethers";
import { requireV3 } from "./configV3";
import { awaitAllowanceVisible } from "./awaitAllowance";
import {
  hashPrecommitment,
  deriveDepositLabel,
  assetIdFromToken,
  hashCommitment,
  randomUserSalt,
  noteAssetAddress,
} from "./noteCryptoV3";
import { assertDepositScreened } from "../sanctionsScreen";
import { requestAspAdmit } from "../aspAdmit";
import { NATIVE_TOKEN } from "../networks";
import { assetSymbolForToken } from "../leafIndexClient";
import { saveV3Note } from "./noteStoreV3";
import { recordDepositOnCursor } from "./noteCursorSession";

export interface DepositV3Params {
  chainId: number;
  token: string;
  amount: bigint;
  signer: Signer;
  /**
   * How to advance the strategy-run cursor after a successful deposit.
   * - `deposit` (default): open a new run on this note
   * - `none`: leave cursor alone (bridge dest deposit — caller runs finalizeVaultBridgeOnCursor)
   */
  cursorMode?: "deposit" | "none";
}

export interface DepositV3Result {
  txHash: string;
  commitment: string;
  depositNonce: bigint;
  noteCommitment: string;
}

const VAULT_KERNEL_ABI = [
  "function deposit(address token, uint256 amount, uint256 userSalt, uint256 precommitment) external returns (uint256)",
  // Native ETH entry — the kernel wraps msg.value to WETH itself, so the note is an ordinary
  // WETH note and the client needs neither a wrap nor an approval.
  "function depositNative(uint256 userSalt, uint256 precommitment) external payable returns (uint256)",
  // Immutable asset adapter — the contract that actually calls transferFrom, so the approval spender.
  "function assets() external view returns (address)",
  // Authoritative post-tx facts: measured `amount` (O-23 amount bind), the real `depositNonce`
  // (post-increment — the value the on-chain label used), and the minted `commitment`.
  //
  // MUST mirror VaultKernel.sol exactly, INDEXED FLAGS INCLUDED. `depositor` is NOT indexed; only
  // `token` is. topic0 is derived from types alone, so a wrong indexed flag still matches the log
  // and then fails to decode — parseLog throws, the event reads as "not found", and depositV3
  // aborts AFTER the deposit is already mined. Field names must match too, since parseDepositedEvent
  // reads them off ev.args.
  "event Deposited(address depositor, address indexed token, uint256 amount, uint256 commitment, uint256 depositNonce, uint256 stateRootAfter)",
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

/**
 * The message to refuse a deposit with, or null to let it proceed.
 *
 * `have === null` means the balance could not be read, and that must NEVER block a deposit — a
 * flaky RPC is not evidence of an empty wallet. We refuse only on a positively-known shortfall.
 *
 * Pure and exported so depositBalance.check.ts can exercise the decision without a chain.
 */
export function depositShortfallMessage(
  need: bigint,
  have: bigint | null,
  decimals: number,
  owner: string,
): string | null {
  if (have === null || have >= need) return null;
  const fmt = (v: bigint) => formatUnits(v, decimals);
  const who = owner.length > 10 ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : owner;
  return (
    `Not enough balance to deposit: this needs ${fmt(need)} but ${who} holds ${fmt(have)}. ` +
    `Fund the wallet and try again — nothing was signed, so this cost you no gas.`
  );
}

export async function depositV3(p: DepositV3Params): Promise<DepositV3Result> {
  const cfg = requireV3(p.chainId);

  if (p.amount <= 0n) {
    throw new Error("depositV3: deposit amount must be greater than zero");
  }

  // Native ETH cannot be a note asset directly: assetId = uint160(token) and withdraw casts it back
  // with tokenFromAssetId, so the note must name a real ERC-20 or it would be unspendable. The
  // kernel wraps msg.value to WETH inside depositNative, so the resulting note is WETH-denominated:
  // `token` is that note's asset from here on, and every derivation must use it, not p.token.
  const isNative =
    !p.token ||
    p.token.toLowerCase() === "0x0000000000000000000000000000000000000000" ||
    p.token.toLowerCase() === NATIVE_TOKEN.toLowerCase();
  const token = noteAssetAddress(p.chainId, p.token);

  const depositorAddress = await p.signer.getAddress();

  // 00) NETWORK PRE-FLIGHT. The vault, token and adapter addresses are per chain; signed on another
  // network the approve and deposit go to whatever lives at those addresses there (or nothing).
  // Like the balance check below, only a positively-known mismatch stops us — a failed read doesn't.
  // eth_chainId goes to the wallet itself — getNetwork() would echo the app's staticNetwork pin.
  const provider = p.signer.provider as { send?: (m: string, a: unknown[]) => Promise<unknown> } | null;
  const walletChain = provider?.send
    ? await provider.send("eth_chainId", []).then((h) => Number(h)).catch(() => null)
    : null;
  if (walletChain != null && walletChain !== p.chainId) {
    throw new Error(
      `Your wallet is on chain ${walletChain}, but this deposit is for chain ${p.chainId}. ` +
        `Switch your wallet's network and try again — nothing was signed.`,
    );
  }

  // 0) BALANCE PRE-FLIGHT.
  //
  // An underfunded wallet does not fail here — it fails four steps later, inside the adapter's
  // transferFrom, as `ERC20: transfer amount exceeds balance`. By then the user has already been
  // shown a scary approval prompt, signed it, and paid gas for it, and what they finally see is an
  // opaque "execution reverted" that says nothing about which balance was short or whose. The
  // preceding `transfer amount exceeds allowance` compounds it, because that one reads like a bug
  // in the approve step rather than a symptom of the same empty wallet.
  //
  // The wallet balance is knowable before any of that, so check it and name the shortfall. This is
  // the only place worth checking: every caller (Build, DetailsModal, quickSwapRun, the v3 leg
  // builder) routes its deposits through here, so one guard covers all of them.
  //
  // Deliberately non-fatal when the READ itself fails: an RPC hiccup must never block a deposit
  // that would otherwise succeed. We only stop when we positively know the funds are not there.
  const funds = await (async (): Promise<{ have: bigint; decimals: number } | null> => {
    try {
      if (isNative) {
        const provider = p.signer.provider;
        if (!provider) return null;
        const have = BigInt((await provider.getBalance(depositorAddress)).toString());
        return { have, decimals: 18 };
      }
      const erc20 = new Contract(token, ERC20_ABI, p.signer);
      const [rawBal, rawDec] = await Promise.all([
        erc20.balanceOf(depositorAddress),
        erc20.decimals(),
      ]);
      return { have: BigInt(rawBal.toString()), decimals: Number(rawDec) };
    } catch {
      return null;
    }
  })();

  const shortMsg = depositShortfallMessage(
    p.amount,
    funds ? funds.have : null,
    funds ? funds.decimals : 18,
    depositorAddress,
  );
  if (shortMsg) throw new Error(shortMsg);

  // 1) Secrets & CSPRNG salt (userSalt MUST be non-zero — enforced by randomUserSalt).
  const nullifier = randomUserSalt();
  const secret = randomUserSalt();
  const userSalt = randomUserSalt();

  // 2) Precommitment (goes on-chain; opens the note only with the secrets).
  const precommitment = await hashPrecommitment(nullifier, secret);

  // 2b) FUND SAFETY: stash the secrets before any transaction.
  //
  // A note is only reconstructible from (nullifier, secret, userSalt) — all three are CSPRNG values
  // living in memory until step 9 writes them. Anything that throws between the mined deposit and
  // that write strands the funds permanently: the label derives from userSalt, which exists nowhere
  // on-chain. That is not hypothetical — a wrong `indexed` flag on the Deposited ABI made step 6
  // throw on a *successful* deposit and burned a real note.
  //
  // The stash is deliberately written before the tx rather than after: after is exactly the window
  // that fails. It is cleared only once the durable note is saved.
  const stashKey = `v3-pending-deposit:${p.chainId}:${precommitment.toString()}`;
  stashPendingDeposit(stashKey, {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    userSalt: userSalt.toString(),
    token,
    amount: p.amount.toString(),
    vaultKernel: cfg.vaultKernel,
    chainId: p.chainId,
  });

  const kernelContract = new Contract(cfg.vaultKernel, VAULT_KERNEL_ABI, p.signer);
  const assetId = assetIdFromToken(token);

  // 3) Depositor compliance screening BEFORE any tx (fail-closed on a hit).
  //
  // The screen MUST carry the note commitment and userSalt. The ASP only opens a pending record
  // when both are present (aspv2 app.py: `decision == admit and user_salt and commitment`), and the
  // deposit watcher admits solely by looking that record up by commitment:
  //
  //     pending = get_pending_by_commitment(db, chain_id, commitment)
  //     if not pending or pending.status != "pending" or not pending.user_salt: skipped += 1
  //
  // Screening with neither still returned `admit`, so the deposit went through and then sat in
  // In Review permanently — the watcher scanned it and skipped it every round.
  //
  // The commitment is not derivable off-chain beforehand (its label folds in depositNonce, which the
  // contract post-increments, and its value is the MEASURED receipt), so predict it with a static
  // call against the exact arguments the real transaction will use.
  //
  // The ERC-20 static call executes `assets.pull` -> `transferFrom`, so it needs the allowance to
  // already exist. Approving first is safe: an allowance moves no custody, so screening still gates
  // every actual movement of funds.
  if (!isNative) {
    // The spender is the ASSET ADAPTER, not the kernel. VaultKernel.deposit() delegates to
    // `assets.pull(token, msg.sender, amount)` and Erc20AssetAdapter.pull() calls
    // `transferFrom(depositor, vault, amount)` itself, so the adapter is `msg.sender` at the token.
    // Approving the kernel left the adapter with none and every deposit reverted on the adapter's
    // `require(..., "transferFrom")`. Read it from the kernel — `assets` is immutable, so it cannot
    // drift from the deployment this flow targets.
    const spender: string = String(await kernelContract.assets());
    const erc20 = new Contract(token, ERC20_ABI, p.signer);
    const allowance: bigint = BigInt(
      (await erc20.allowance(depositorAddress, spender)).toString(),
    );
    if (allowance < p.amount) {
      const approveTx = await erc20.approve(spender, p.amount);
      await approveTx.wait(1);
      // wait(1) only proves ONE backend saw it. The staticCall below reads the allowance again, so
      // wait until a read actually reflects the approve — see awaitAllowanceVisible.
      await awaitAllowanceVisible(
        async () => BigInt((await erc20.allowance(depositorAddress, spender)).toString()),
        p.amount,
      );
    }
  }

  const predictedCommitment: bigint = isNative
    ? BigInt(
        (await kernelContract.depositNative.staticCall(
          userSalt.toString(),
          precommitment.toString(),
          { value: p.amount },
        )).toString(),
      )
    : BigInt(
        (await kernelContract.deposit.staticCall(
          token,
          p.amount,
          userSalt.toString(),
          precommitment.toString(),
        )).toString(),
      );

  await assertDepositScreened({
    address: depositorAddress,
    chainId: p.chainId,
    asset: token,
    commitment: predictedCommitment.toString(),
    userSalt: userSalt.toString(),
  });

  // 4) Submit. Native goes through depositNative — the kernel wraps msg.value to WETH in the same
  // transaction, so there is no client-side wrap and no approval: one signature instead of three.
  // userSalt is a tx parameter but is NEVER logged or emitted (PROTOCOL §2.3).
  const tx = isNative
    ? await kernelContract.depositNative(userSalt.toString(), precommitment.toString(), {
        value: p.amount,
      })
    : await kernelContract.deposit(
        token,
        p.amount,
        userSalt.toString(),
        precommitment.toString(),
      );

  const receipt = await tx.wait(1);

  // 6) Parse the Deposited event for AUTHORITATIVE facts — the contract increments depositNonce
  //    before minting the label and binds `received` (the measured delta), which can differ from
  //    the requested `amount` for fee-on-transfer tokens (O-23). Deriving from a pre-read counter
  //    or the requested amount would produce an unspendable note.
  const parsed = parseDepositedEvent(receipt, kernelContract, cfg.vaultKernel);
  if (!parsed) throw new Error("depositV3: Deposited event not found in receipt");
  const { received, depositNonce, noteCommitment: onChainCommitment } = parsed;

  // 7) Derive label + commitment from the event's nonce/received.
  const label = await deriveDepositLabel({
    chainId: p.chainId,
    vaultAddress: cfg.vaultKernel,
    depositNonce,
    userSalt,
  });
  const commitment = await hashCommitment(received, label, assetId, nullifier, secret);

  // 8) Correctness check: our derived commitment MUST equal the leaf the contract inserted.
  if (commitment !== onChainCommitment) {
    throw new Error(
      `depositV3: derived commitment ${commitment} != on-chain noteCommitment ${onChainCommitment} — do not store an unspendable note`,
    );
  }

  // The pre-flight screen is keyed by a commitment predicted with depositNonce at `latest`.
  // Another user's deposit can consume that nonce while this user is approving/signing, so the
  // prediction is only a screening hint. Re-key admission from the mined event's authoritative
  // nonce and label; otherwise the watcher never finds the pending row and the note can remain in
  // review forever. requestAspAdmit handles the expected 1-vs-2-confirmation race in background.
  await requestAspAdmit({
    chainId: p.chainId,
    label: label.toString(),
    txHash: receipt.hash ?? tx.hash,
    vault: cfg.vaultKernel,
    depositor: depositorAddress,
    signer: p.signer,
    // v5 emits Deposited, not LabelMinted: the route verifies the receipt by commitment and the ASP
    // derives the label from the salt (it requires userSalt).
    commitment: onChainCommitment.toString(),
    userSalt: userSalt.toString(),
  });

  // The server re-reads this block before issuing an exit ticket; keeping the timestamp in the
  // encrypted note lets the UI display the same five-minute window without another RPC per poll.
  let depositTimestamp = Math.floor(Date.now() / 1_000);
  try {
    const block = await p.signer.provider?.getBlock(receipt.blockNumber);
    if (block?.timestamp) depositTimestamp = Number(block.timestamp);
  } catch {
    // Display fallback only. The request route always enforces the authoritative block timestamp.
  }

  // 9) Persist the note (value = measured `received`, not the requested amount).
  const depositSymbol =
    assetSymbolForToken(p.token, p.chainId) ?? assetSymbolForToken(token, p.chainId) ?? token;
  const depositTxHash = receipt.hash ?? tx.hash;
  await saveV3Note(
    p.chainId,
    {
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      label: label.toString(),
      assetId: assetId.toString(),
      // Store under the DISPLAYED symbol (ETH), not the note asset (WETH). WETH is not in
      // getTokens(), so resolving from `token` yielded null and filed the note under a raw
      // address. assetId below still binds WETH — that is what the chain and circuits use.
      symbol: depositSymbol,
      commitment: commitment.toString(),
      value: received,
      precommitment: precommitment.toString(),
      depositTxHash,
      userSalt: userSalt.toString(),
      depositTimestamp,
      origin: "deposit",
      spent: "false",
    },
    p.signer,
    "deposit",
  );

  // Strategy-run cursor: deposit opens a fresh run pointing at this note (fail-open).
  // Bridge destination deposits skip this — finalizeVaultBridgeOnCursor advances the same run.
  if (p.cursorMode !== "none") {
    recordDepositOnCursor({
      chainId: p.chainId,
      symbol: depositSymbol,
      commitment: commitment.toString(),
      value: received,
      txHash: depositTxHash,
    });
  }

  // The durable note is written — the pre-tx stash has done its job.
  clearPendingDeposit(stashKey);

  return {
    txHash: receipt.hash ?? tx.hash,
    commitment: commitment.toString(),
    depositNonce,
    noteCommitment: commitment.toString(),
  };
}

/**
 * Pre-transaction secret stash (see the call site for why this exists).
 *
 * Best-effort by design: a storage failure must never block a deposit, and the durable record is
 * still saveV3Note. This only has to survive the window between a mined deposit and that write.
 */
function stashPendingDeposit(key: string, value: Record<string, unknown>): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({ ...value, ts: Date.now() }));
  } catch {
    /* private mode / quota / SSR — proceed, the note is still saved on the happy path */
  }
}

function clearPendingDeposit(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* nothing to do — a stale stash is recoverable, an unwritten note is not */
  }
}

/** Parse the vault's Deposited event from a receipt → authoritative received/nonce/commitment. */
function parseDepositedEvent(
  receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] },
  kernel: Contract,
  vaultKernel: string,
): { received: bigint; depositNonce: bigint; noteCommitment: bigint } | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== vaultKernel.toLowerCase()) continue;
    let ev;
    try {
      ev = kernel.interface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (ev?.name !== "Deposited") continue;
    return {
      received: BigInt(ev.args.amount.toString()),
      depositNonce: BigInt(ev.args.depositNonce.toString()),
      noteCommitment: BigInt(ev.args.commitment.toString()),
    };
  }
  return null;
}

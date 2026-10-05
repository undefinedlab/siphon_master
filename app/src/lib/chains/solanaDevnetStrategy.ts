/**
 * Solana Devnet orders — settled on Meteora DLMM, output returned into the vault.
 * SOL ↔ USDC. The browser proves a Groth16 spend to the executor's settlement wallet and keeps
 * every secret (input notes and the return note); the executor submits the spend when the order's
 * trigger fires, swaps, and deposits the output under the user's precommitment.
 */
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { submitEncryptedStrategy } from "@/lib/strategySubmit";
import { authorizeExecution } from "@/lib/strategyAuthorizer";
import { getStrategies } from "@/lib/strategyApi";
import {
  assetIdFromSolanaMint,
  hashCommitmentWithPre,
  hashNullifier,
  hashPrecommitment,
  mintLabelSalted,
  randomUserSalt,
} from "@/lib/v3/noteCryptoV3";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import {
  DEVNET_JITO_SOL_MINT,
  DEVNET_JL_USDC_MINT,
  DEVNET_USDC_MINT,
  JITO_STAKE_POOL_DEVNET,
  JUPITER_LEND_DEVNET_PROGRAM,
  getDevnetConnection,
  type PhantomLike,
} from "@/lib/chains/solanaVaultOnchain";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";
import { getPhantom } from "@/lib/chains/solanaWallet";
import {
  bytesToHex,
  fetchZkVaultState,
  fieldToLe32,
  getZkProgramId,
  leToField,
  proveSolanaZkSpend,
  splitZkSolana,
  zkNullifierPda,
  type SolanaZkSpendProof,
} from "@/lib/chains/solanaVaultZk";
import {
  deleteSolanaNote,
  deleteSolanaPendingReturn,
  isSpendableSolanaNote,
  loadSolanaNotes,
  loadSolanaPendingReturns,
  markSolanaNoteSpent,
  saveSolanaNote,
  saveSolanaPendingReturn,
  solanaDecimalsForSymbol,
  solanaSymbolForMint,
  unspendSolanaNote,
  type SolanaNoteSymbol,
  type SolanaPendingReturn,
} from "@/lib/chains/solanaNoteStore";

export type MeteoraSide = "sell_usdc" | "sell_wsol" | "sell_jlusdc" | "sell_jitosol";
export type MeteoraPair = "usdc_sol" | "jlusdc_sol" | "jitosol_sol";

export type MeteoraZkPackage = {
  venue: "meteora-dlmm";
  program_id: string;
  circuit: string;
  circuit_index: number;
  binder_hex: string;
  proof_hex: string;
  publics: string[];
  nullifiers_hex: string[];
  mint: string;
  settlement: string;
  meteora_pool: string;
  meteora_pair: MeteoraPair;
  solana_side: MeteoraSide;
  solana_mint: string;
  solana_usdc_mint: string;
  state_root: string;
  amount_base_units: string;
  commitment_hex: string;
};

type SettlementInfo = {
  pubkey: string;
  meteoraPool: string;
  meteoraJlUsdcSolPool?: string;
  meteoraJitoSolPool?: string;
  usdcMint: string;
  jlUsdcMint?: string;
  jitoSolMint?: string;
  jitoStakePool?: string;
  lendingProgram?: string;
};

export type JupiterEarnZkPackage = {
  venue: "jupiter-earn";
  action: "enter" | "exit";
  program_id: string;
  circuit: string;
  circuit_index: number;
  binder_hex: string;
  proof_hex: string;
  publics: string[];
  nullifiers_hex: string[];
  mint: string;
  settlement: string;
  asset_mint: string;
  jl_token_mint: string;
  lending_program: string;
  state_root: string;
  amount_base_units: string;
  commitment_hex: string;
};

export type JitoStakeZkPackage = {
  venue: "jito-stake";
  action: "enter" | "exit";
  program_id: string;
  circuit: string;
  circuit_index: number;
  binder_hex: string;
  proof_hex: string;
  publics: string[];
  nullifiers_hex: string[];
  mint: string;
  settlement: string;
  jito_sol_mint: string;
  stake_pool: string;
  state_root: string;
  amount_base_units: string;
  commitment_hex: string;
};

function settlementExtras(body: Partial<SettlementInfo> = {}): Pick<
  SettlementInfo,
  "meteoraJlUsdcSolPool" | "meteoraJitoSolPool" | "jitoSolMint" | "jitoStakePool"
> {
  return {
    meteoraJlUsdcSolPool:
      (process.env.NEXT_PUBLIC_METEORA_JLUSDC_SOL_POOL || "").trim() || body.meteoraJlUsdcSolPool || "",
    meteoraJitoSolPool:
      (process.env.NEXT_PUBLIC_METEORA_JITOSOL_SOL_POOL || "").trim() || body.meteoraJitoSolPool || "",
    jitoSolMint: body.jitoSolMint || DEVNET_JITO_SOL_MINT.toBase58(),
    jitoStakePool: body.jitoStakePool || JITO_STAKE_POOL_DEVNET.toBase58(),
  };
}

export async function fetchSolanaSettlement(): Promise<SettlementInfo> {
  const envPool = (process.env.NEXT_PUBLIC_METEORA_POOL || "").trim();
  const envSettle = (process.env.NEXT_PUBLIC_SOLANA_SETTLEMENT_PUBKEY || "").trim();
  const envUsdc = (process.env.NEXT_PUBLIC_SOLANA_USDC_MINT || "").trim();
  const envJl = (process.env.NEXT_PUBLIC_JUPITER_JL_USDC_MINT || "").trim();
  if (envPool && envSettle) {
    return {
      pubkey: envSettle,
      meteoraPool: envPool,
      usdcMint: envUsdc || DEVNET_USDC_MINT.toBase58(),
      jlUsdcMint: envJl || DEVNET_JL_USDC_MINT.toBase58(),
      lendingProgram: JUPITER_LEND_DEVNET_PROGRAM.toBase58(),
      ...settlementExtras(),
    };
  }
  const res = await fetch(`${getTradeExecutorBaseUrl()}/solana/settlement`);
  const body = (await res.json().catch(() => ({}))) as Partial<SettlementInfo> & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `settlement lookup failed (HTTP ${res.status})`);
  }
  const pubkey = envSettle || body.pubkey || "";
  const meteoraPool = envPool || body.meteoraPool || "";
  if (!pubkey || !meteoraPool) {
    throw new Error("Executor has no Meteora pool or settlement pubkey. Run setup-meteora-devnet-pool.mjs.");
  }
  return {
    pubkey,
    meteoraPool,
    usdcMint: body.usdcMint || envUsdc || DEVNET_USDC_MINT.toBase58(),
    jlUsdcMint: body.jlUsdcMint || envJl || DEVNET_JL_USDC_MINT.toBase58(),
    lendingProgram: body.lendingProgram || JUPITER_LEND_DEVNET_PROGRAM.toBase58(),
    ...settlementExtras(body),
  };
}

/** Settlement lookup that does not require a Meteora pool (Earn / Jito arming). */
export async function fetchSolanaEarnSettlement(): Promise<SettlementInfo> {
  const envSettle = (process.env.NEXT_PUBLIC_SOLANA_SETTLEMENT_PUBKEY || "").trim();
  const envUsdc = (process.env.NEXT_PUBLIC_SOLANA_USDC_MINT || "").trim();
  const envJl = (process.env.NEXT_PUBLIC_JUPITER_JL_USDC_MINT || "").trim();
  if (envSettle) {
    return {
      pubkey: envSettle,
      meteoraPool: (process.env.NEXT_PUBLIC_METEORA_POOL || "").trim(),
      usdcMint: envUsdc || DEVNET_USDC_MINT.toBase58(),
      jlUsdcMint: envJl || DEVNET_JL_USDC_MINT.toBase58(),
      lendingProgram: JUPITER_LEND_DEVNET_PROGRAM.toBase58(),
      ...settlementExtras(),
    };
  }
  const res = await fetch(`${getTradeExecutorBaseUrl()}/solana/settlement`);
  const body = (await res.json().catch(() => ({}))) as Partial<SettlementInfo> & {
    error?: string;
    pubkey?: string;
  };
  const pubkey = body.pubkey || "";
  if (!res.ok && !pubkey) {
    throw new Error(body.error || `settlement lookup failed (HTTP ${res.status})`);
  }
  if (!pubkey) throw new Error("Executor has no settlement pubkey for Jupiter Earn / Jito stake.");
  return {
    pubkey,
    meteoraPool: body.meteoraPool || "",
    usdcMint: body.usdcMint || envUsdc || DEVNET_USDC_MINT.toBase58(),
    jlUsdcMint: body.jlUsdcMint || envJl || DEVNET_JL_USDC_MINT.toBase58(),
    lendingProgram: body.lendingProgram || JUPITER_LEND_DEVNET_PROGRAM.toBase58(),
    ...settlementExtras(body),
  };
}

export function earnPackageFromProof(
  proof: SolanaZkSpendProof,
  settle: SettlementInfo,
  action: "enter" | "exit",
): JupiterEarnZkPackage {
  return {
    venue: "jupiter-earn",
    action,
    program_id: proof.programId.toBase58(),
    circuit: proof.circuit,
    circuit_index: proof.circuitIndex,
    binder_hex: bytesToHex(proof.binder),
    proof_hex: bytesToHex(proof.proof),
    publics: proof.publics,
    nullifiers_hex: proof.nullifiers.map((n) => bytesToHex(n)),
    mint: proof.mint.toBase58(),
    settlement: settle.pubkey,
    asset_mint: settle.usdcMint,
    jl_token_mint: settle.jlUsdcMint || DEVNET_JL_USDC_MINT.toBase58(),
    lending_program: settle.lendingProgram || JUPITER_LEND_DEVNET_PROGRAM.toBase58(),
    state_root: proof.stateRoot,
    amount_base_units: proof.amountBaseUnits,
    commitment_hex: proof.inputCommitmentHexes[0] || "",
  };
}

export function jitoPackageFromProof(
  proof: SolanaZkSpendProof,
  settle: SettlementInfo,
  action: "enter" | "exit",
): JitoStakeZkPackage {
  return {
    venue: "jito-stake",
    action,
    program_id: proof.programId.toBase58(),
    circuit: proof.circuit,
    circuit_index: proof.circuitIndex,
    binder_hex: bytesToHex(proof.binder),
    proof_hex: bytesToHex(proof.proof),
    publics: proof.publics,
    nullifiers_hex: proof.nullifiers.map((n) => bytesToHex(n)),
    mint: proof.mint.toBase58(),
    settlement: settle.pubkey,
    jito_sol_mint: settle.jitoSolMint || DEVNET_JITO_SOL_MINT.toBase58(),
    stake_pool: settle.jitoStakePool || JITO_STAKE_POOL_DEVNET.toBase58(),
    state_root: proof.stateRoot,
    amount_base_units: proof.amountBaseUnits,
    commitment_hex: proof.inputCommitmentHexes[0] || "",
  };
}

function poolForPair(settle: SettlementInfo, pair: MeteoraPair): string {
  if (pair === "jlusdc_sol") {
    const p = (settle.meteoraJlUsdcSolPool || "").trim();
    if (!p) {
      throw new Error(
        "No jlUSDC/SOL Meteora pool. Run setup-meteora-devnet-pool.mjs with PAIR=jlusdc-sol.",
      );
    }
    return p;
  }
  if (pair === "jitosol_sol") {
    const p = (settle.meteoraJitoSolPool || "").trim();
    if (!p) {
      throw new Error(
        "No JitoSOL/SOL Meteora pool. Run setup-meteora-devnet-pool.mjs with PAIR=jitosol-sol.",
      );
    }
    return p;
  }
  return settle.meteoraPool;
}

export function meteoraPackageFromProof(
  proof: SolanaZkSpendProof,
  settle: SettlementInfo,
  side: MeteoraSide,
  pair: MeteoraPair = "usdc_sol",
): MeteoraZkPackage {
  return {
    venue: "meteora-dlmm",
    program_id: proof.programId.toBase58(),
    circuit: proof.circuit,
    circuit_index: proof.circuitIndex,
    binder_hex: bytesToHex(proof.binder),
    proof_hex: bytesToHex(proof.proof),
    publics: proof.publics,
    nullifiers_hex: proof.nullifiers.map((n) => bytesToHex(n)),
    mint: proof.mint.toBase58(),
    settlement: settle.pubkey,
    meteora_pool: poolForPair(settle, pair),
    meteora_pair: pair,
    solana_side: side,
    solana_mint: proof.mint.toBase58(),
    solana_usdc_mint: settle.usdcMint,
    state_root: proof.stateRoot,
    amount_base_units: proof.amountBaseUnits,
    commitment_hex: proof.inputCommitmentHexes[0] || "",
  };
}

function baseUnits(amountHuman: number, symbol: string): bigint {
  const decimals = solanaDecimalsForSymbol(symbol);
  const scaled = Math.round(amountHuman * 10 ** decimals);
  if (!Number.isFinite(scaled) || scaled <= 0) throw new Error("Enter a valid amount.");
  return BigInt(scaled);
}

const SOL_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** Builder trees default their price leaf to ETH; on Devnet the volatile leg is SOL. */
function solanaTree(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as { op?: string; asset?: string; price_feed_id?: string; conditions?: unknown[] };
  if (n.op === "LEAF") {
    const asset = (n.asset || "ETH").toUpperCase();
    if (asset === "ETH") return { ...n, asset: "SOL", price_feed_id: SOL_FEED };
    return asset === "SOL" && !n.price_feed_id ? { ...n, price_feed_id: SOL_FEED } : n;
  }
  return { ...n, conditions: (n.conditions ?? []).map(solanaTree) };
}

type OrderPair = {
  mintIn: PublicKey;
  mintOut: PublicKey;
  symIn: SolanaNoteSymbol;
  side: MeteoraSide;
  pair: MeteoraPair;
  assetInLabel: string;
  assetOutLabel: string;
};

function orderPair(assetIn: string, assetOut: string): OrderPair {
  const a = assetIn.toUpperCase().replace(/_/g, "");
  const b = assetOut.toUpperCase().replace(/_/g, "");
  if (a === "USDC" && (b === "SOL" || b === "WSOL")) {
    return {
      mintIn: DEVNET_USDC_MINT,
      mintOut: NATIVE_MINT,
      symIn: "USDC",
      side: "sell_usdc",
      pair: "usdc_sol",
      assetInLabel: "USDC",
      assetOutLabel: "SOL",
    };
  }
  if ((a === "SOL" || a === "WSOL") && b === "USDC") {
    return {
      mintIn: NATIVE_MINT,
      mintOut: DEVNET_USDC_MINT,
      symIn: "SOL",
      side: "sell_wsol",
      pair: "usdc_sol",
      assetInLabel: "SOL",
      assetOutLabel: "USDC",
    };
  }
  if (a === "JLUSDC" && (b === "SOL" || b === "WSOL")) {
    return {
      mintIn: DEVNET_JL_USDC_MINT,
      mintOut: NATIVE_MINT,
      symIn: "jlUSDC",
      side: "sell_jlusdc",
      pair: "jlusdc_sol",
      assetInLabel: "jlUSDC",
      assetOutLabel: "SOL",
    };
  }
  if ((a === "SOL" || a === "WSOL") && b === "JLUSDC") {
    return {
      mintIn: NATIVE_MINT,
      mintOut: DEVNET_JL_USDC_MINT,
      symIn: "SOL",
      side: "sell_wsol",
      pair: "jlusdc_sol",
      assetInLabel: "SOL",
      assetOutLabel: "jlUSDC",
    };
  }
  if (a === "JITOSOL" && (b === "SOL" || b === "WSOL")) {
    return {
      mintIn: DEVNET_JITO_SOL_MINT,
      mintOut: NATIVE_MINT,
      symIn: "JitoSOL",
      side: "sell_jitosol",
      pair: "jitosol_sol",
      assetInLabel: "JitoSOL",
      assetOutLabel: "SOL",
    };
  }
  if ((a === "SOL" || a === "WSOL") && b === "JITOSOL") {
    return {
      mintIn: NATIVE_MINT,
      mintOut: DEVNET_JITO_SOL_MINT,
      symIn: "SOL",
      side: "sell_wsol",
      pair: "jitosol_sol",
      assetInLabel: "SOL",
      assetOutLabel: "JitoSOL",
    };
  }
  throw new Error("Solana Devnet orders swap SOL ↔ USDC, jlUSDC ↔ SOL, or JitoSOL ↔ SOL.");
}

/**
 * Arm a resting Devnet order whose output returns to the vault.
 *
 * Proves a WITHDRAW of the order's notes to the executor's settlement wallet (it cannot be proved
 * later: the notes' secrets live only here) and hands the executor the precommitment + label salt
 * of a NEW note for the output. When the trigger fires, the executor spends, swaps on Meteora and
 * deposits the output under that precommitment — a note only this wallet can spend, which
 * resolveSolanaDevnetOrders adds to the vault once the executor reports it. Nothing fires at arm
 * time unless `executeNow` (a market/quick swap).
 */
export async function armSolanaDevnetOrder(p: {
  amountHuman: number;
  assetIn: string;
  assetOut: string;
  /** Executor strategy_type (LIMIT_BUY, LIMIT_SELL, STOP_LOSS, TAKE_PROFIT…). */
  strategyType: string;
  conditionTree?: unknown;
  upperBound?: number;
  lowerBound?: number;
  maxSlippageBps?: number;
  windowHours: number;
  executeNow?: boolean;
  onStatus?: (message: string) => void;
}): Promise<{ strategyId: string; executed: boolean }> {
  const userId = getPhantom()?.publicKey?.toString();
  if (!userId) throw new Error("Connect Phantom to place a Devnet order.");
  const pair = orderPair(p.assetIn, p.assetOut);
  const say = p.onStatus ?? (() => undefined);

  say("Looking up the settlement wallet…");
  const settle = await fetchSolanaSettlement();
  say("Proving the order's spend…");
  const proof = await proveSolanaZkSpend({
    owner: userId,
    mint: pair.mintIn,
    amountBaseUnits: baseUnits(p.amountHuman, pair.symIn),
    recipient: settle.pubkey,
    onStatus: say,
  });

  const nullifier = randomUserSalt();
  const secret = randomUserSalt();
  const userSalt = randomUserSalt();
  const pending: SolanaPendingReturn = {
    id: bytesToHex(proof.binder),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    userSalt: userSalt.toString(),
    precommitment: (await hashPrecommitment(nullifier, secret)).toString(),
    mintOut: pair.mintOut.toBase58(),
    amountBaseUnits: proof.amountBaseUnits,
    inputCommitmentHexes: proof.inputCommitmentHexes,
    inputSymbol: pair.symIn,
    changeCommitmentHex: proof.changeNote?.commitmentHex,
    createdAt: Date.now(),
  };
  // Secrets before the order exists: an order whose return note nobody can open is lost output.
  await saveSolanaPendingReturn(userId, pending);
  if (proof.changeNote) await saveSolanaNote(userId, proof.changeNote); // pending until it fires
  // Reserve the inputs so a second order or a withdraw cannot pick a note this one will spend.
  for (const hex of proof.inputCommitmentHexes) await markSolanaNoteSpent(userId, hex);

  const undo = async () => {
    for (const hex of proof.inputCommitmentHexes) await unspendSolanaNote(userId, hex);
    if (proof.changeNote) deleteSolanaNote(proof.changeNote.symbol, proof.changeNote.commitmentHex);
    deleteSolanaPendingReturn(pending.id);
  };

  say("Attesting the TEE and sealing the ClientKey…");
  const submitted = await submitEncryptedStrategy(
    {
      user_id: userId,
      strategy_type: p.strategyType,
      asset_in: pair.assetInLabel,
      asset_out: pair.assetOutLabel,
      amount: p.amountHuman,
      recipient_address: userId,
      from_chain: String(SOLANA_DEVNET_CHAIN_ID),
      to_chain: String(SOLANA_DEVNET_CHAIN_ID),
      output_mode: "vault",
      ...(p.conditionTree != null
        ? { condition_tree: solanaTree(p.conditionTree), upper_bound: 0, lower_bound: 0 }
        : { upper_bound: p.upperBound ?? 0, lower_bound: p.lowerBound ?? 0 }),
      max_slippage_bps: p.maxSlippageBps ?? 100,
      execution_window_sec: Math.round(p.windowHours * 3600),
      schedule_anchor: Math.floor(Date.now() / 1000),
      is_private: true,
      zk_proof: {
        ...meteoraPackageFromProof(proof, settle, pair.side, pair.pair),
        return_precommitment: pending.precommitment,
        return_user_salt: pending.userSalt,
      },
      solana_side: pair.side,
      meteora_pair: pair.pair,
      ...(p.executeNow ? { execute_now: true } : {}),
    },
    {
      onUploadClientKey: () => say("Uploading sealed ClientKey to the decryptor…"),
      onEncrypt: () => say("Encrypting the trigger bounds (FHE)…"),
    },
  ).catch(async (e) => {
    await undo();
    throw e;
  });
  if (!submitted.success) {
    await undo();
    throw new Error(submitted.error || "The executor refused the order.");
  }
  const strategyId = String(submitted.data?.strategy_id ?? "");
  await saveSolanaPendingReturn(userId, { ...pending, strategyId });
  const auto = submitted.data?.auto_execute as { status?: string; error?: string } | undefined;
  if (auto?.status === "FAILED") {
    // Gives the inputs back once the chain confirms nothing was spent.
    await resolveSolanaDevnetOrders(userId).catch(() => {});
    throw new Error(auto.error || "The swap could not be settled.");
  }
  return { strategyId, executed: auto?.status === "EXECUTED" };
}

/** Up to 8 notes per split; a leftover beyond the order's amount takes one slot. */
const MAX_SPLIT = 8;

/** `legs` equal slices of `total` (the last takes the rounding), then the note's leftover if any. */
export function devnetSplitValues(noteValue: bigint, total: bigint, legs: number): bigint[] {
  const each = total / BigInt(legs);
  if (each <= 0n) throw new Error("Amount too small for that many legs.");
  const values = Array.from({ length: legs }, (_, i) => (i === legs - 1 ? total - each * BigInt(legs - 1) : each));
  return noteValue > total ? [...values, noteValue - total] : values;
}

/**
 * Arm a multi-leg Devnet order (TWAP, DCA, grid / loop): one note is split into a slice per leg
 * (plus the leftover, which stays in the vault), and each slice is proved as its own withdraw to
 * the settlement wallet with its own return note — the same per-leg package a single order
 * carries. Legs fire on their own encrypted trigger (time for TWAP/DCA, price rung for a grid).
 */
export async function armSolanaDevnetMultiLeg(p: {
  kind: "TWAP" | "DCA" | "RANGE_GRID";
  amountHuman: number;
  assetIn: string;
  assetOut: string;
  legCount: number;
  intervalSec?: number;
  low?: number;
  high?: number;
  maxSlippageBps?: number;
  windowHours: number;
  onStatus?: (message: string) => void;
}): Promise<{ strategyId: string; legs: number }> {
  const phantom = getPhantom();
  const userId = phantom?.publicKey?.toString();
  if (!phantom || !userId) throw new Error("Connect Phantom to place a Devnet order.");
  const pair = orderPair(p.assetIn, p.assetOut);
  const say = p.onStatus ?? (() => undefined);
  const n = Math.floor(p.legCount);
  if (!(n >= 2 && n <= MAX_SPLIT)) throw new Error(`A Devnet ${p.kind} runs 2 to ${MAX_SPLIT} legs.`);
  const total = baseUnits(p.amountHuman, pair.symIn);

  // The split circuit spends one whole note: take the smallest that covers the order.
  const note = (await loadSolanaNotes(userId))
    .filter((x) => isSpendableSolanaNote(x) && x.mint === pair.mintIn.toBase58() && BigInt(x.value) >= total)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1))[0];
  if (!note) {
    throw new Error(`No single Devnet ${pair.symIn} note holds ${p.amountHuman} — deposit that amount first.`);
  }
  if (BigInt(note.value) > total && n > MAX_SPLIT - 1) {
    throw new Error(`Use at most ${MAX_SPLIT - 1} legs, or deposit exactly ${p.amountHuman} ${pair.symIn}.`);
  }
  const values = devnetSplitValues(BigInt(note.value), total, n);

  // Encryption needs the client key; the legs carry their own triggers.
  const { getOrCreateClientKey } = await import("@/lib/fhe");
  const { twapEncryptLeg, gridEncryptLeg } = await import("@/lib/multiLegBuilder");
  const clientKey = await getOrCreateClientKey(userId);
  const timed = p.kind !== "RANGE_GRID";
  const intervalSec = Math.max(1, Math.floor(p.intervalSec ?? 60));
  const encryptLeg = timed
    ? twapEncryptLeg(intervalSec, clientKey)
    : gridEncryptLeg(p.low ?? 0, p.high ?? 0, n, pair.symIn, clientKey);

  say(`Splitting ${p.amountHuman} ${pair.symIn} into ${n} legs…`);
  const signer: PhantomLike = {
    publicKey: { toBytes: () => new PublicKey(userId).toBytes(), toString: () => userId },
    signTransaction: (tx) => phantom.signTransaction!(tx),
    signAndSendTransaction: phantom.signAndSendTransaction
      ? (tx) => phantom.signAndSendTransaction!(tx)
      : undefined,
  };
  const split = await splitZkSolana({ phantom: signer, note, values, onStatus: say });
  const settle = await fetchSolanaSettlement();
  const decimals = solanaDecimalsForSymbol(pair.symIn);
  const anchor = Math.floor(Date.now() / 1000);

  const pendings: SolanaPendingReturn[] = [];
  const legs: Record<string, unknown>[] = [];
  const undo = async () => {
    for (const r of pendings) {
      for (const hex of r.inputCommitmentHexes) await unspendSolanaNote(userId, hex);
      deleteSolanaPendingReturn(r.id);
    }
  };
  try {
    for (let i = 0; i < n; i++) {
      const slice = split.slices[i];
      say(`Proving leg ${i + 1} of ${n}…`);
      const proof = await proveSolanaZkSpend({
        owner: userId,
        mint: pair.mintIn,
        amountBaseUnits: BigInt(slice.value),
        recipient: settle.pubkey,
        notes: [slice],
        fetchLeaves: async () => split.leaves,
      });
      const nullifier = randomUserSalt();
      const secret = randomUserSalt();
      const userSalt = randomUserSalt();
      const pending: SolanaPendingReturn = {
        id: bytesToHex(proof.binder),
        legIndex: i,
        nullifier: nullifier.toString(),
        secret: secret.toString(),
        userSalt: userSalt.toString(),
        precommitment: (await hashPrecommitment(nullifier, secret)).toString(),
        mintOut: pair.mintOut.toBase58(),
        amountBaseUnits: proof.amountBaseUnits,
        inputCommitmentHexes: proof.inputCommitmentHexes,
        inputSymbol: pair.symIn,
        createdAt: Date.now(),
      };
      await saveSolanaPendingReturn(userId, pending);
      await markSolanaNoteSpent(userId, slice.commitmentHex);
      pendings.push(pending);
      legs.push({
        leg_index: i,
        amount: Number(slice.value) / 10 ** decimals,
        ...(await encryptLeg(i)),
        zk_proof: {
          ...meteoraPackageFromProof(proof, settle, pair.side, pair.pair),
          return_precommitment: pending.precommitment,
          return_user_salt: pending.userSalt,
        },
      });
    }

    // Later legs must not expire before their fire time.
    const windowHours = timed ? Math.max(p.windowHours, ((n - 1) * intervalSec + 3600) / 3600) : p.windowHours;
    say(`Attesting the TEE and sealing the ClientKey (${n} legs)…`);
    const submitted = await submitEncryptedStrategy(
      {
        user_id: userId,
        strategy_type: p.kind,
        asset_in: pair.assetInLabel,
        asset_out: pair.assetOutLabel,
        amount: p.amountHuman,
        recipient_address: userId,
        from_chain: String(SOLANA_DEVNET_CHAIN_ID),
        to_chain: String(SOLANA_DEVNET_CHAIN_ID),
        output_mode: "vault",
        legs: legs as unknown as Parameters<typeof submitEncryptedStrategy>[0]["legs"],
        ...(timed ? { interval_sec: intervalSec } : { grid_levels: n }),
        max_slippage_bps: p.maxSlippageBps ?? 100,
        schedule_anchor: anchor,
        execution_window_sec: Math.round(windowHours * 3600),
        is_private: true,
        solana_side: pair.side,
        meteora_pair: pair.pair,
      },
      {
        onUploadClientKey: () => say("Uploading sealed ClientKey to the decryptor…"),
        onEncrypt: () => say("Encrypting leg triggers (FHE)…"),
      },
    );
    if (!submitted.success) throw new Error(submitted.error || "The executor refused the order.");
    const strategyId = String(submitted.data?.strategy_id ?? "");
    for (const r of pendings) await saveSolanaPendingReturn(userId, { ...r, strategyId });
    return { strategyId, legs: n };
  } catch (e) {
    // The slices stay in the vault as ordinary notes; only the order is abandoned.
    await undo();
    throw e;
  }
}

type DevnetSettlement = {
  waiting?: string;
  returned_note?: { commitment: string; deposit_nonce: string; leaf_index: string; amount: string; mint: string; deposit_sig?: string | null };
};

async function nullifierSpent(hex: string, owner: string): Promise<boolean> {
  const note = (await loadSolanaNotes(owner)).find((n) => n.commitmentHex.toLowerCase() === hex.toLowerCase());
  if (!note) return false;
  const nf = await hashNullifier(BigInt(note.nullifier));
  const info = await getDevnetConnection().getAccountInfo(zkNullifierPda(fieldToLe32(nf))[0], "confirmed");
  return info !== null;
}

/**
 * Bring armed Devnet orders' results into the vault: a fired order's returned note becomes a
 * spendable note (rebuilt from the executor's record and checked against its commitment) and its
 * change note is confirmed; an order that ended unfired gives its inputs back; one waiting on a
 * stale proof is re-proved and the fresh proof attached without firing. Only touches the network
 * when this wallet has armed orders.
 */
export async function resolveSolanaDevnetOrders(owner: string): Promise<void> {
  if (getPhantom()?.publicKey?.toString() !== owner) return;
  const armed = (await loadSolanaPendingReturns(owner)).filter((r) => r.strategyId);
  if (!armed.length) return;
  const list = await getStrategies(owner);
  if (!list.success) return;
  const byId = new Map((list.strategies ?? []).map((s) => [String(s.id), s as unknown as Record<string, unknown>]));

  for (const r of armed) {
    const s = byId.get(String(r.strategyId));
    if (!s) continue;
    let status = String(s.status || "");
    let settlement = (s.settlement ?? {}) as DevnetSettlement;
    const isPipeline = String(s.strategy_type || "").toUpperCase() === "PIPELINE";
    if (r.legIndex !== undefined) {
      const legs = (s.legs ?? []) as Array<Record<string, unknown>>;
      const leg = legs.find((l) => Number(l.leg_index) === r.legIndex);
      if (!leg) continue;
      const parentOver = ["FAILED", "EXPIRED", "ABORTED", "CANCELLED", "EXECUTED"].includes(status);
      status = String(leg.status || "");
      // A leg that never fired under a finished order is over too; one mid-settlement is not.
      if (parentOver && (status === "PENDING" || status === "ARMED" || status === "QUEUED")) status = "EXPIRED";
      settlement = (leg.settlement ?? {}) as DevnetSettlement;
      // PIPELINE hop-0 NEEDS_REPROOF: browser re-proves using pipelineHop0Return secrets.
      if (isPipeline) {
        const hop0 = legs.find((l) => Number(l.leg_index) === 0);
        const hop0Settle = (hop0?.settlement ?? {}) as DevnetSettlement;
        if (hop0Settle.waiting === "NEEDS_REPROOF" && r.pipelineHop0Return) {
          try {
            await reprovePipelineHop0(owner, r, hop0Settle);
          } catch (e) {
            console.warn(`[devnet] pipeline hop0 reprove ${r.strategyId}:`, e);
          }
        }
        // Mid-pipeline failure after hop 0 spent: adopt hop-0's returned note with hop-0
        // secrets so value is not stranded in the TEE-only return.
        const hop0Done = String(hop0?.status || "") === "EXECUTED" && hop0Settle.returned_note;
        const finalDone = legs.some(
          (l) => Number(l.leg_index) === legs.length - 1 && String(l.status) === "EXECUTED",
        );
        if (parentOver && hop0Done && !finalDone && r.pipelineHop0Return) {
          try {
            await saveReturnedNoteWithSecrets(owner, r.pipelineHop0Return, hop0Settle.returned_note!);
            if (r.changeCommitmentHex) await confirmChange(owner, r.changeCommitmentHex, String(s.tx_hash || ""));
            deleteSolanaPendingReturn(r.id);
          } catch (e) {
            console.warn(`[devnet] pipeline mid-fail recover ${r.strategyId}:`, e);
          }
          continue;
        }
        // Final hop not done yet (and parent still live) — intermediate returns stay in TEE.
        if (status !== "EXECUTED" && !parentOver) continue;
      }
    }
    try {
      if (status === "EXECUTED" && settlement.returned_note) {
        await saveReturnedNote(owner, r, settlement.returned_note);
        if (r.changeCommitmentHex) await confirmChange(owner, r.changeCommitmentHex, String(s.tx_hash || ""));
        deleteSolanaPendingReturn(r.id);
      } else if (["FAILED", "EXPIRED", "ABORTED", "CANCELLED"].includes(status)) {
        // Give the inputs back only if the chain agrees nothing was spent.
        if (await nullifierSpent(r.inputCommitmentHexes[0], owner)) continue;
        for (const hex of r.inputCommitmentHexes) await unspendSolanaNote(owner, hex);
        if (r.changeCommitmentHex) deleteSolanaNote(r.inputSymbol, r.changeCommitmentHex);
        deleteSolanaPendingReturn(r.id);
      } else if (settlement.waiting === "NEEDS_REPROOF" && !isPipeline) {
        await reproveOrder(owner, r);
      }
    } catch (e) {
      console.warn(`[devnet] could not resolve order ${r.strategyId}:`, e);
    }
  }
}

/** Hop cursor for UI: `{ current, total }` from parent zkp_data / executed legs. */
export function pipelineHopCursor(s: Record<string, unknown>): { current: number; total: number } | null {
  if (String(s.strategy_type || "").toUpperCase() !== "PIPELINE") return null;
  const zkp = (s.zkp_data ?? {}) as { hop_cursor?: number; hop_count?: number };
  const legs = (s.legs ?? []) as Array<Record<string, unknown>>;
  const total = Number(zkp.hop_count || s.leg_count || legs.length || 0);
  if (!total) return null;
  const current = Number(
    zkp.hop_cursor ??
      legs.filter((l) => String(l.status) === "EXECUTED").length,
  );
  return { current, total };
}

async function saveReturnedNoteWithSecrets(
  owner: string,
  secrets: { nullifier: string; secret: string; userSalt: string; precommitment: string },
  n: NonNullable<DevnetSettlement["returned_note"]>,
): Promise<void> {
  const vault = await fetchZkVaultState(getDevnetConnection(), getZkProgramId());
  const label = await mintLabelSalted(
    leToField(vault.vaultScopeId),
    BigInt(n.deposit_nonce),
    BigInt(secrets.userSalt),
  );
  const mint = new PublicKey(n.mint);
  const assetId = assetIdFromSolanaMint(mint.toBytes());
  const commitment = await hashCommitmentWithPre(
    BigInt(n.amount),
    label,
    assetId,
    BigInt(secrets.precommitment),
  );
  if (commitment.toString() !== String(n.commitment)) {
    throw new Error("returned note does not match the executor's deposit");
  }
  await saveSolanaNote(owner, {
    nullifier: secrets.nullifier,
    secret: secrets.secret,
    label: label.toString(),
    assetId: assetId.toString(),
    mint: mint.toBase58(),
    symbol: solanaSymbolForMint(mint.toBase58()),
    commitment: commitment.toString(),
    commitmentHex: bytesToHex(fieldToLe32(commitment)),
    value: String(n.amount),
    precommitment: secrets.precommitment,
    userSalt: secrets.userSalt,
    depositSig: n.deposit_sig || "pipeline-recover",
    leafIndex: Number(n.leaf_index),
    spent: false,
  });
}

async function saveReturnedNote(
  owner: string,
  r: SolanaPendingReturn,
  n: NonNullable<DevnetSettlement["returned_note"]>,
): Promise<void> {
  await saveReturnedNoteWithSecrets(
    owner,
    {
      nullifier: r.nullifier,
      secret: r.secret,
      userSalt: r.userSalt,
      precommitment: r.precommitment,
    },
    n,
  );
}

async function confirmChange(owner: string, hex: string, sig: string): Promise<void> {
  const note = (await loadSolanaNotes(owner)).find((n) => n.commitmentHex.toLowerCase() === hex.toLowerCase());
  if (note && !note.depositSig) await saveSolanaNote(owner, { ...note, depositSig: sig || "spent-change" });
}

async function reprovePipelineHop0(
  owner: string,
  r: SolanaPendingReturn,
  _settlement: DevnetSettlement,
): Promise<void> {
  const hop0 = r.pipelineHop0Return;
  if (!hop0) return;
  const inputs = (await loadSolanaNotes(owner))
    .filter((n) => r.inputCommitmentHexes.some((h) => h.toLowerCase() === n.commitmentHex.toLowerCase()))
    .map((n) => ({ ...n, spent: false }));
  if (inputs.length !== r.inputCommitmentHexes.length) return;
  const settle =
    r.inputSymbol === "USDC" || r.inputSymbol === "jlUSDC"
      ? await fetchSolanaEarnSettlement()
      : await fetchSolanaSettlement();
  const proof = await proveSolanaZkSpend({
    owner,
    mint: new PublicKey(inputs[0].mint),
    amountBaseUnits: BigInt(r.amountBaseUnits),
    recipient: settle.pubkey,
    notes: inputs,
  });
  if (r.changeCommitmentHex) deleteSolanaNote(r.inputSymbol, r.changeCommitmentHex);
  if (proof.changeNote) await saveSolanaNote(owner, proof.changeNote);
  await saveSolanaPendingReturn(owner, { ...r, changeCommitmentHex: proof.changeNote?.commitmentHex });
  const list = await getStrategies(owner);
  const s = (list.strategies ?? []).find((x) => String(x.id) === String(r.strategyId)) as
    | Record<string, unknown>
    | undefined;
  const hop0Leg = ((s?.legs ?? []) as Array<Record<string, unknown>>).find((l) => Number(l.leg_index) === 0);
  const venue = String((hop0Leg?.zkp_data as { venue?: string } | undefined)?.venue || "meteora-dlmm");
  let pkg: Record<string, unknown>;
  if (venue === "jupiter-earn") {
    const action = ((hop0Leg?.zkp_data as { action?: string })?.action || "enter") as "enter" | "exit";
    pkg = earnPackageFromProof(proof, settle, action);
  } else if (venue === "jito-stake") {
    const action = ((hop0Leg?.zkp_data as { action?: string })?.action || "enter") as "enter" | "exit";
    pkg = jitoPackageFromProof(proof, settle, action);
  } else {
    const side: MeteoraSide =
      r.inputSymbol === "jlUSDC"
        ? "sell_jlusdc"
        : r.inputSymbol === "JitoSOL"
          ? "sell_jitosol"
          : r.inputSymbol === "USDC"
            ? "sell_usdc"
            : "sell_wsol";
    const pair: MeteoraPair =
      r.inputSymbol === "jlUSDC" ? "jlusdc_sol" : r.inputSymbol === "JitoSOL" ? "jitosol_sol" : "usdc_sol";
    pkg = meteoraPackageFromProof(proof, settle, side, pair);
  }
  await authorizeExecution(String(r.strategyId), owner, {
    zkp_data: {
      ...pkg,
      return_precommitment: hop0.precommitment,
      return_user_salt: hop0.userSalt,
    },
    refresh_only: true,
    leg_index: 0,
  });
}

async function reproveOrder(owner: string, r: SolanaPendingReturn): Promise<void> {
  const inputs = (await loadSolanaNotes(owner))
    .filter((n) => r.inputCommitmentHexes.some((h) => h.toLowerCase() === n.commitmentHex.toLowerCase()))
    .map((n) => ({ ...n, spent: false }));
  if (inputs.length !== r.inputCommitmentHexes.length) return;
  const settle = await fetchSolanaSettlement();
  const proof = await proveSolanaZkSpend({
    owner,
    mint: new PublicKey(inputs[0].mint),
    amountBaseUnits: BigInt(r.amountBaseUnits),
    recipient: settle.pubkey,
    notes: inputs,
  });
  if (r.changeCommitmentHex) deleteSolanaNote(r.inputSymbol, r.changeCommitmentHex);
  if (proof.changeNote) await saveSolanaNote(owner, proof.changeNote);
  await saveSolanaPendingReturn(owner, { ...r, changeCommitmentHex: proof.changeNote?.commitmentHex });
  const side: MeteoraSide =
    r.inputSymbol === "jlUSDC"
      ? "sell_jlusdc"
      : r.inputSymbol === "JitoSOL"
        ? "sell_jitosol"
        : r.inputSymbol === "USDC"
          ? "sell_usdc"
          : "sell_wsol";
  const pair: MeteoraPair =
    r.inputSymbol === "jlUSDC" ? "jlusdc_sol" : r.inputSymbol === "JitoSOL" ? "jitosol_sol" : "usdc_sol";
  await authorizeExecution(String(r.strategyId), owner, {
    zkp_data: {
      ...meteoraPackageFromProof(proof, settle, side, pair),
      return_precommitment: r.precommitment,
      return_user_salt: r.userSalt,
    },
    refresh_only: true,
    leg_index: r.legIndex,
  });
}

/**
 * Arm a Jupiter Earn Enter (USDC note → jlUSDC note) or Exit (jlUSDC → USDC + yield).
 * Settles immediately (`execute_now`) — no price trigger; the venue is lending, not a swap.
 */
export async function armSolanaDevnetEarn(p: {
  action: "enter" | "exit";
  amountHuman: number;
  windowHours?: number;
  onStatus?: (message: string) => void;
}): Promise<{ strategyId: string; executed: boolean }> {
  const userId = getPhantom()?.publicKey?.toString();
  if (!userId) throw new Error("Connect Phantom to place a Devnet Earn order.");
  const say = p.onStatus ?? (() => undefined);
  const enter = p.action === "enter";
  const mintIn = enter ? DEVNET_USDC_MINT : DEVNET_JL_USDC_MINT;
  const mintOut = enter ? DEVNET_JL_USDC_MINT : DEVNET_USDC_MINT;
  const symIn: SolanaNoteSymbol = enter ? "USDC" : "jlUSDC";

  say("Looking up the settlement wallet…");
  const settle = await fetchSolanaEarnSettlement();
  say(enter ? "Proving Earn Enter spend…" : "Proving Earn Exit spend…");
  const proof = await proveSolanaZkSpend({
    owner: userId,
    mint: mintIn,
    amountBaseUnits: baseUnits(p.amountHuman, symIn),
    recipient: settle.pubkey,
    onStatus: say,
  });

  const nullifier = randomUserSalt();
  const secret = randomUserSalt();
  const userSalt = randomUserSalt();
  const pending: SolanaPendingReturn = {
    id: bytesToHex(proof.binder),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    userSalt: userSalt.toString(),
    precommitment: (await hashPrecommitment(nullifier, secret)).toString(),
    mintOut: mintOut.toBase58(),
    amountBaseUnits: proof.amountBaseUnits,
    inputCommitmentHexes: proof.inputCommitmentHexes,
    inputSymbol: symIn,
    changeCommitmentHex: proof.changeNote?.commitmentHex,
    createdAt: Date.now(),
  };
  await saveSolanaPendingReturn(userId, pending);
  if (proof.changeNote) await saveSolanaNote(userId, proof.changeNote);
  for (const hex of proof.inputCommitmentHexes) await markSolanaNoteSpent(userId, hex);

  const undo = async () => {
    for (const hex of proof.inputCommitmentHexes) await unspendSolanaNote(userId, hex);
    if (proof.changeNote) deleteSolanaNote(proof.changeNote.symbol, proof.changeNote.commitmentHex);
    deleteSolanaPendingReturn(pending.id);
  };

  say("Attesting the TEE and sealing the ClientKey…");
  const submitted = await submitEncryptedStrategy(
    {
      user_id: userId,
      strategy_type: enter ? "EARN_ENTER" : "EARN_EXIT",
      asset_in: enter ? "USDC" : "jlUSDC",
      asset_out: enter ? "jlUSDC" : "USDC",
      amount: p.amountHuman,
      recipient_address: userId,
      from_chain: String(SOLANA_DEVNET_CHAIN_ID),
      to_chain: String(SOLANA_DEVNET_CHAIN_ID),
      output_mode: "vault",
      upper_bound: 0,
      lower_bound: 0,
      max_slippage_bps: 50,
      execution_window_sec: Math.round((p.windowHours ?? 24) * 3600),
      schedule_anchor: Math.floor(Date.now() / 1000),
      is_private: true,
      execute_now: true,
      zk_proof: {
        ...earnPackageFromProof(proof, settle, p.action),
        return_precommitment: pending.precommitment,
        return_user_salt: pending.userSalt,
      },
    },
    {
      onUploadClientKey: () => say("Uploading sealed ClientKey to the decryptor…"),
      onEncrypt: () => say("Encrypting Earn order…"),
    },
  ).catch(async (e) => {
    await undo();
    throw e;
  });
  if (!submitted.success) {
    await undo();
    throw new Error(submitted.error || "The executor refused the Earn order.");
  }
  const strategyId = String(submitted.data?.strategy_id ?? "");
  await saveSolanaPendingReturn(userId, { ...pending, strategyId });
  const auto = submitted.data?.auto_execute as { status?: string; error?: string } | undefined;
  if (auto?.status === "FAILED") {
    await resolveSolanaDevnetOrders(userId).catch(() => {});
    throw new Error(auto.error || "Earn settlement failed.");
  }
  return { strategyId, executed: auto?.status === "EXECUTED" };
}

/**
 * Arm a Jito stake Enter (SOL note → JitoSOL note) or Exit (JitoSOL → SOL).
 * Settles immediately (`execute_now`) — mirror of Jupiter Earn for liquid staking.
 */
export async function armSolanaDevnetStake(p: {
  action: "enter" | "exit";
  amountHuman: number;
  windowHours?: number;
  onStatus?: (message: string) => void;
}): Promise<{ strategyId: string; executed: boolean }> {
  const userId = getPhantom()?.publicKey?.toString();
  if (!userId) throw new Error("Connect Phantom to place a Devnet stake order.");
  const say = p.onStatus ?? (() => undefined);
  const enter = p.action === "enter";
  const mintIn = enter ? NATIVE_MINT : DEVNET_JITO_SOL_MINT;
  const mintOut = enter ? DEVNET_JITO_SOL_MINT : NATIVE_MINT;
  const symIn: SolanaNoteSymbol = enter ? "SOL" : "JitoSOL";

  say("Looking up the settlement wallet…");
  const settle = await fetchSolanaEarnSettlement();
  say(enter ? "Proving Jito stake Enter spend…" : "Proving Jito unstake spend…");
  const proof = await proveSolanaZkSpend({
    owner: userId,
    mint: mintIn,
    amountBaseUnits: baseUnits(p.amountHuman, symIn),
    recipient: settle.pubkey,
    onStatus: say,
  });

  const nullifier = randomUserSalt();
  const secret = randomUserSalt();
  const userSalt = randomUserSalt();
  const pending: SolanaPendingReturn = {
    id: bytesToHex(proof.binder),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    userSalt: userSalt.toString(),
    precommitment: (await hashPrecommitment(nullifier, secret)).toString(),
    mintOut: mintOut.toBase58(),
    amountBaseUnits: proof.amountBaseUnits,
    inputCommitmentHexes: proof.inputCommitmentHexes,
    inputSymbol: symIn,
    changeCommitmentHex: proof.changeNote?.commitmentHex,
    createdAt: Date.now(),
  };
  await saveSolanaPendingReturn(userId, pending);
  if (proof.changeNote) await saveSolanaNote(userId, proof.changeNote);
  for (const hex of proof.inputCommitmentHexes) await markSolanaNoteSpent(userId, hex);

  const undo = async () => {
    for (const hex of proof.inputCommitmentHexes) await unspendSolanaNote(userId, hex);
    if (proof.changeNote) deleteSolanaNote(proof.changeNote.symbol, proof.changeNote.commitmentHex);
    deleteSolanaPendingReturn(pending.id);
  };

  say("Attesting the TEE and sealing the ClientKey…");
  const submitted = await submitEncryptedStrategy(
    {
      user_id: userId,
      strategy_type: enter ? "STAKE_ENTER" : "STAKE_EXIT",
      asset_in: enter ? "SOL" : "JitoSOL",
      asset_out: enter ? "JitoSOL" : "SOL",
      amount: p.amountHuman,
      recipient_address: userId,
      from_chain: String(SOLANA_DEVNET_CHAIN_ID),
      to_chain: String(SOLANA_DEVNET_CHAIN_ID),
      output_mode: "vault",
      upper_bound: 0,
      lower_bound: 0,
      max_slippage_bps: 50,
      execution_window_sec: Math.round((p.windowHours ?? 24) * 3600),
      schedule_anchor: Math.floor(Date.now() / 1000),
      is_private: true,
      execute_now: true,
      zk_proof: {
        ...jitoPackageFromProof(proof, settle, p.action),
        return_precommitment: pending.precommitment,
        return_user_salt: pending.userSalt,
      },
    },
    {
      onUploadClientKey: () => say("Uploading sealed ClientKey to the decryptor…"),
      onEncrypt: () => say("Encrypting stake order…"),
    },
  ).catch(async (e) => {
    await undo();
    throw e;
  });
  if (!submitted.success) {
    await undo();
    throw new Error(submitted.error || "The executor refused the stake order.");
  }
  const strategyId = String(submitted.data?.strategy_id ?? "");
  await saveSolanaPendingReturn(userId, { ...pending, strategyId });
  const auto = submitted.data?.auto_execute as { status?: string; error?: string } | undefined;
  if (auto?.status === "FAILED") {
    await resolveSolanaDevnetOrders(userId).catch(() => {});
    throw new Error(auto.error || "Jito stake settlement failed.");
  }
  return { strategyId, executed: auto?.status === "EXECUTED" };
}

export type PipelineHopSpec = {
  venue: "jupiter-earn" | "meteora-dlmm" | "jito-stake";
  action?: "enter" | "exit";
  assetIn: string;
  assetOut: string;
  meteora_pair?: MeteoraPair;
  slippage_bps?: number;
};

function mintOutForHop(h: PipelineHopSpec): PublicKey {
  const out = h.assetOut.toUpperCase().replace(/_/g, "");
  if (out === "JLUSDC") return DEVNET_JL_USDC_MINT;
  if (out === "JITOSOL") return DEVNET_JITO_SOL_MINT;
  if (out === "USDC") return DEVNET_USDC_MINT;
  return NATIVE_MINT;
}

function hop0VenuePackage(
  proof: SolanaZkSpendProof,
  settle: SettlementInfo,
  hop: PipelineHopSpec,
): Record<string, unknown> {
  if (hop.venue === "jupiter-earn") {
    return earnPackageFromProof(proof, settle, hop.action === "exit" ? "exit" : "enter");
  }
  if (hop.venue === "jito-stake") {
    return jitoPackageFromProof(proof, settle, hop.action === "exit" ? "exit" : "enter");
  }
  const pair = hop.meteora_pair || orderPair(hop.assetIn, hop.assetOut).pair;
  const side = orderPair(hop.assetIn, hop.assetOut).side;
  return meteoraPackageFromProof(proof, settle, side, pair);
}

function hopSkeleton(settle: SettlementInfo, hop: PipelineHopSpec): Record<string, unknown> {
  if (hop.venue === "jupiter-earn") {
    const enter = hop.action !== "exit";
    return {
      venue: "jupiter-earn",
      action: enter ? "enter" : "exit",
      settlement: settle.pubkey,
      asset_mint: settle.usdcMint,
      jl_token_mint: settle.jlUsdcMint || DEVNET_JL_USDC_MINT.toBase58(),
      lending_program: settle.lendingProgram || JUPITER_LEND_DEVNET_PROGRAM.toBase58(),
    };
  }
  if (hop.venue === "jito-stake") {
    return {
      venue: "jito-stake",
      action: hop.action === "exit" ? "exit" : "enter",
      settlement: settle.pubkey,
      jito_sol_mint: settle.jitoSolMint || DEVNET_JITO_SOL_MINT.toBase58(),
      stake_pool: settle.jitoStakePool || JITO_STAKE_POOL_DEVNET.toBase58(),
    };
  }
  const pair = hop.meteora_pair || orderPair(hop.assetIn, hop.assetOut).pair;
  const side = orderPair(hop.assetIn, hop.assetOut).side;
  return {
    venue: "meteora-dlmm",
    settlement: settle.pubkey,
    meteora_pair: pair,
    meteora_pool: poolForPair(settle, pair),
    solana_side: side,
    solana_mint: orderPair(hop.assetIn, hop.assetOut).mintIn.toBase58(),
    solana_usdc_mint: settle.usdcMint,
  };
}

/**
 * Arm a private multi-hop PIPELINE on Solana Devnet.
 *
 * Samples return-note secrets for every hop, seals the PipelineNoteBundle to the TEE, proves and
 * submits hop 0 only. Hops 1..N are proved by the TEE after each prior hop's returned_note lands.
 */
export async function armSolanaDevnetPipeline(p: {
  hops: PipelineHopSpec[];
  amountHuman: number;
  conditionTree?: unknown;
  upperBound?: number;
  lowerBound?: number;
  maxSlippageBps?: number;
  windowHours?: number;
  /** Fire hop 0 immediately (Earn enter, market swap, …). */
  executeNow?: boolean;
  onStatus?: (message: string) => void;
}): Promise<{ strategyId: string; hops: number; executed: boolean }> {
  const userId = getPhantom()?.publicKey?.toString();
  if (!userId) throw new Error("Connect Phantom to arm a Devnet pipeline.");
  if (!p.hops.length) throw new Error("Pipeline needs at least one hop.");
  if (p.hops.length > 8) throw new Error("Pipeline supports at most 8 hops.");
  const say = p.onStatus ?? (() => undefined);
  const hop0 = p.hops[0];
  const last = p.hops[p.hops.length - 1];

  say("Looking up the settlement wallet…");
  const settle =
    hop0.venue === "meteora-dlmm" ? await fetchSolanaSettlement() : await fetchSolanaEarnSettlement();

  const { sealPipelineBundle } = await import("@/lib/chains/pipelineSeal");
  const { hashPrecommitment } = await import("@/lib/v3/noteCryptoV3");

  say("Sampling return secrets for every hop…");
  const hopSecrets = [];
  for (let i = 0; i < p.hops.length; i++) {
    const nullifier = randomUserSalt();
    const secret = randomUserSalt();
    const userSalt = randomUserSalt();
    hopSecrets.push({
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      userSalt: userSalt.toString(),
      precommitment: (await hashPrecommitment(nullifier, secret)).toString(),
    });
  }

  say("Attesting the TEE and sealing the pipeline note bundle…");
  const sealed = await sealPipelineBundle({ version: 1, hops: hopSecrets });

  const mintIn =
    hop0.venue === "jupiter-earn"
      ? hop0.action === "exit"
        ? DEVNET_JL_USDC_MINT
        : DEVNET_USDC_MINT
      : hop0.venue === "jito-stake"
        ? hop0.action === "exit"
          ? DEVNET_JITO_SOL_MINT
          : NATIVE_MINT
        : orderPair(hop0.assetIn, hop0.assetOut).mintIn;
  const symIn = solanaSymbolForMint(mintIn.toBase58());

  say("Proving hop 0 spend…");
  const proof = await proveSolanaZkSpend({
    owner: userId,
    mint: mintIn,
    amountBaseUnits: baseUnits(p.amountHuman, symIn),
    recipient: settle.pubkey,
    onStatus: say,
  });

  const pending: SolanaPendingReturn = {
    id: bytesToHex(proof.binder),
    legIndex: p.hops.length - 1, // adopt only the FINAL hop's returned note
    nullifier: hopSecrets[p.hops.length - 1].nullifier,
    secret: hopSecrets[p.hops.length - 1].secret,
    userSalt: hopSecrets[p.hops.length - 1].userSalt,
    precommitment: hopSecrets[p.hops.length - 1].precommitment,
    mintOut: mintOutForHop(last).toBase58(),
    amountBaseUnits: proof.amountBaseUnits,
    inputCommitmentHexes: proof.inputCommitmentHexes,
    inputSymbol: symIn,
    changeCommitmentHex: proof.changeNote?.commitmentHex,
    pipelineHop0Return: {
      nullifier: hopSecrets[0].nullifier,
      secret: hopSecrets[0].secret,
      userSalt: hopSecrets[0].userSalt,
      precommitment: hopSecrets[0].precommitment,
    },
    createdAt: Date.now(),
  };
  await saveSolanaPendingReturn(userId, pending);
  if (proof.changeNote) await saveSolanaNote(userId, proof.changeNote);
  for (const hex of proof.inputCommitmentHexes) await markSolanaNoteSpent(userId, hex);

  const undo = async () => {
    for (const hex of proof.inputCommitmentHexes) await unspendSolanaNote(userId, hex);
    if (proof.changeNote) deleteSolanaNote(proof.changeNote.symbol, proof.changeNote.commitmentHex);
    deleteSolanaPendingReturn(pending.id);
  };

  const legs: Record<string, unknown>[] = [];
  for (let i = 0; i < p.hops.length; i++) {
    const hop = p.hops[i];
    const ret = hopSecrets[i];
    if (i === 0) {
      legs.push({
        leg_index: 0,
        amount: p.amountHuman,
        eval_mode: p.conditionTree || p.upperBound || p.lowerBound ? "price" : "pipeline",
        ...(p.conditionTree
          ? {}
          : p.upperBound != null || p.lowerBound != null
            ? {}
            : {}),
        zk_proof: {
          ...hop0VenuePackage(proof, settle, hop),
          return_precommitment: ret.precommitment,
          return_user_salt: ret.userSalt,
        },
      });
    } else {
      legs.push({
        leg_index: i,
        amount: p.amountHuman,
        eval_mode: "pipeline",
        zk_proof: {
          ...hopSkeleton(settle, hop),
          // Placeholders — TEE fills return_* at prove time from the sealed bundle.
          return_precommitment: ret.precommitment,
          return_user_salt: ret.userSalt,
        },
      });
    }
  }

  // Hop 0 may carry an FHE/price trigger; later hops auto-fire after EXECUTED.
  // Market pipelines (execute_now, no price tree) must NOT send dummy upper/lower=0 — that forced
  // a pointless FHE encrypt + TEE key sync and was surfacing as a hop-0 "encryption" failure.
  const hasTrigger = Boolean(p.conditionTree) || (p.upperBound != null && p.upperBound > 0) || (p.lowerBound != null && p.lowerBound > 0);

  say(`Submitting PIPELINE (${p.hops.length} hops)…`);
  const submitted = await submitEncryptedStrategy(
    {
      user_id: userId,
      strategy_type: "PIPELINE",
      asset_in: hop0.assetIn,
      asset_out: last.assetOut,
      amount: p.amountHuman,
      recipient_address: userId,
      from_chain: String(SOLANA_DEVNET_CHAIN_ID),
      to_chain: String(SOLANA_DEVNET_CHAIN_ID),
      output_mode: "vault",
      legs: legs as unknown as Parameters<typeof submitEncryptedStrategy>[0]["legs"],
      pipeline_sealed: sealed,
      ...(hasTrigger && p.conditionTree
        ? { condition_tree: solanaTree(p.conditionTree) }
        : hasTrigger
          ? { upper_bound: p.upperBound ?? 0, lower_bound: p.lowerBound ?? 0 }
          : {}),
      max_slippage_bps: p.maxSlippageBps ?? 100,
      execution_window_sec: Math.round((p.windowHours ?? 24) * 3600),
      schedule_anchor: Math.floor(Date.now() / 1000),
      is_private: true,
      ...(p.executeNow || !hasTrigger ? { execute_now: true } : {}),
    },
    {
      onUploadClientKey: () => say("Uploading sealed ClientKey to the decryptor…"),
      onEncrypt: () => say("Encrypting hop-0 trigger (FHE)…"),
    },
  ).catch(async (e) => {
    await undo();
    throw e;
  });
  if (!submitted.success) {
    await undo();
    throw new Error(submitted.error || "The executor refused the pipeline.");
  }
  const strategyId = String(submitted.data?.strategy_id ?? "");
  await saveSolanaPendingReturn(userId, { ...pending, strategyId });
  const auto = submitted.data?.auto_execute as { status?: string; error?: string } | undefined;
  if (auto?.status === "FAILED") {
    await resolveSolanaDevnetOrders(userId).catch(() => {});
    throw new Error(auto.error || "Pipeline hop 0 could not be settled.");
  }
  return {
    strategyId,
    hops: p.hops.length,
    executed: auto?.status === "EXECUTED",
  };
}

/** Stop an armed Devnet order. Its inputs come back on the next resolve, once the executor agrees. */
export async function abortSolanaDevnetOrder(strategyId: string): Promise<{ ok: boolean; error?: string }> {
  const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
  const res = await fetch(`${getTradeExecutorBaseUrl()}/strategies/${encodeURIComponent(strategyId)}/abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) },
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error || `HTTP ${res.status}` };
}

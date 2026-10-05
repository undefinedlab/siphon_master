/**
 * Siphon Solana Devnet on-chain vault client (hackathon BPF MVP).
 * Matches programs/siphon-vault-onchain discriminators + PDA seeds.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";

/**
 * The LEGACY FHE vault (plaintext note PDAs + FHE auto-pool). Kept for archaeology and as the
 * default program id; the product path moved to the ZK vault (`solanaVaultZk.ts`) — a program id
 * that differs from this one, or NEXT_PUBLIC_SIPHON_SOLANA_ZK=1, selects ZK mode.
 */
export const LEGACY_FHE_PROGRAM_ID = "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj";

export const SIPHON_VAULT_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID?.trim() || LEGACY_FHE_PROGRAM_ID,
);

/** Live Devnet vault-allowed mint (Circle devnet USDC). Override via NEXT_PUBLIC_SOLANA_USDC_MINT. */
export const DEVNET_USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_SOLANA_USDC_MINT?.trim() ||
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

/** Jupiter Earn jlUSDC on Devnet (f_token PDA for Circle USDC under Lending 7tjE28…). */
export const DEVNET_JL_USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_JUPITER_JL_USDC_MINT?.trim() ||
    "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu",
);

/** JitoSOL on Devnet (stake-pool mint for JitoY5… under program DPoo15…). */
export const DEVNET_JITO_SOL_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_JITO_SOL_MINT?.trim() || "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi",
);

export const JITO_STAKE_POOL_DEVNET = new PublicKey(
  process.env.NEXT_PUBLIC_JITO_STAKE_POOL?.trim() || "JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ",
);

export const JUPITER_LEND_DEVNET_PROGRAM = new PublicKey(
  "7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3",
);

export const VAULT_SEED = new TextEncoder().encode("siphon-vault-v1");
export const COMPLIANCE_SEED = new TextEncoder().encode("siphon-compliance-v1");
export const NOTE_SEED = new TextEncoder().encode("siphon-note-v1");
export const COMMIT_DOMAIN = new TextEncoder().encode("siphon-solana-devnet-deposit-v1");

export type PhantomLike = {
  publicKey: { toBytes(): Uint8Array; toString(): string };
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;
};

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return new Uint8Array(buf);
}

/** Anchor instruction discriminator: sha256("global:<name>")[0..8] */
export async function ixDiscriminator(name: string): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(`global:${name}`);
  const digest = await sha256(enc);
  return digest.slice(0, 8);
}

export function vaultPda(programId: PublicKey = SIPHON_VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED], programId);
}

export function compliancePda(programId: PublicKey = SIPHON_VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COMPLIANCE_SEED], programId);
}

export async function commitmentHash(params: {
  amount: bigint;
  mint: PublicKey;
  userSalt: Uint8Array;
  precommitment: Uint8Array;
}): Promise<Uint8Array> {
  const amountLe = new Uint8Array(8);
  const view = new DataView(amountLe.buffer);
  view.setBigUint64(0, params.amount, true);
  const parts = [
    COMMIT_DOMAIN,
    amountLe,
    params.mint.toBytes(),
    params.userSalt,
    params.precommitment,
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const joined = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    o += p.length;
  }
  return sha256(joined);
}

export function notePda(
  commitment: Uint8Array,
  programId: PublicKey = SIPHON_VAULT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([NOTE_SEED, commitment], programId);
}

export function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  // ensure non-zero salt
  if (out.every((b) => b === 0)) out[0] = 1;
  return out;
}

function u64Le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function solanaDevnetRpc(): string {
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    "https://api.devnet.solana.com"
  );
}

export function getDevnetConnection(): Connection {
  return new Connection(solanaDevnetRpc(), "confirmed");
}

/** Human SOL → lamports (9 decimals). */
export function solToLamports(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Enter a valid SOL amount.");
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(9)).slice(0, 9);
  return BigInt(whole + padded);
}

/** Phantom wallet SOL + Siphon test USDC balances on Devnet. */
export async function fetchSolanaDevnetWalletBalances(owner: string): Promise<
  Array<{ symbol: string; balance: string; decimals: number }>
> {
  const connection = getDevnetConnection();
  const pk = new PublicKey(owner);
  const lamports = await connection.getBalance(pk, "confirmed");
  const sol = Number(lamports) / 1e9;

  let usdcRaw = 0n;
  try {
    const ata = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, pk);
    const info = await connection.getTokenAccountBalance(ata);
    usdcRaw = BigInt(info.value.amount);
  } catch {
    /* no USDC ATA yet */
  }
  const usdc = Number(usdcRaw) / 1e6;

  return [
    { symbol: "SOL", balance: sol.toFixed(9).replace(/\.?0+$/, "") || "0", decimals: 9 },
    { symbol: "USDC", balance: usdc.toFixed(6).replace(/\.?0+$/, "") || "0", decimals: 6 },
  ];
}

/** Build initialize_vault ix (authority = payer). */
export async function buildInitializeVaultIx(params: {
  authority: PublicKey;
  mint?: PublicKey;
  programVersion?: Uint8Array;
}): Promise<TransactionInstruction> {
  const mint = params.mint ?? DEVNET_USDC_MINT;
  const [vault] = vaultPda();
  const disc = await ixDiscriminator("initialize_vault");
  const version = params.programVersion ?? new Uint8Array(32);
  return new TransactionInstruction({
    programId: SIPHON_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(disc, version)),
  });
}

/** Build deposit ix for Phantom signing. */
export async function buildDepositIx(params: {
  depositor: PublicKey;
  amount: bigint;
  userSalt: Uint8Array;
  precommitment: Uint8Array;
  mint?: PublicKey;
}): Promise<{
  ix: TransactionInstruction;
  commitment: Uint8Array;
  note: PublicKey;
  vault: PublicKey;
}> {
  const mint = params.mint ?? DEVNET_USDC_MINT;
  const [vault] = vaultPda();
  const commitment = await commitmentHash({
    amount: params.amount,
    mint,
    userSalt: params.userSalt,
    precommitment: params.precommitment,
  });
  const [note] = notePda(commitment);
  const depositorToken = getAssociatedTokenAddressSync(mint, params.depositor);
  const vaultToken = getAssociatedTokenAddressSync(mint, vault, true);
  const disc = await ixDiscriminator("deposit");
  const data = concatBytes(
    disc,
    u64Le(params.amount),
    params.userSalt,
    params.precommitment,
  );
  const ix = new TransactionInstruction({
    programId: SIPHON_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: params.depositor, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: depositorToken, isSigner: false, isWritable: true },
      { pubkey: vaultToken, isSigner: false, isWritable: true },
      { pubkey: note, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
  return { ix, commitment, note, vault };
}

export type SolanaNativeDepositResult = {
  signature: string;
  commitmentHex: string;
  notePubkey: string;
  amount: string;
  chainId: typeof SOLANA_DEVNET_CHAIN_ID;
  mint: string;
};

function formatSolanaSendError(err: unknown): string {
  const e = err as {
    message?: string;
    logs?: string[];
    data?: { logs?: string[] };
    error?: { message?: string; logs?: string[] };
  };
  const logs = e.logs ?? e.data?.logs ?? e.error?.logs;
  const msg = e.message ?? e.error?.message ?? String(err ?? "Transaction failed");
  if (
    /network disabled|active networks|disabled this network|testnet mode|unknown network/i.test(msg)
  ) {
    return (
      "Phantom has Solana Devnet disabled. " +
      "Settings → Developer Settings → Testnet Mode → Solana Devnet. Mainnet SOL does not fund this vault."
    );
  }
  if (logs?.length) {
    const tail = logs.filter(Boolean).slice(-6).join(" | ");
    return `${msg} — ${tail}`;
  }
  if (/unexpected error/i.test(msg)) {
    return `${msg} (Phantom often hides simulation details — try a smaller amount and keep ≥0.05 SOL for fees/rent.)`;
  }
  if (/insufficient|not enough|no funds/i.test(msg)) {
    return (
      `${msg} — This is Solana Devnet, not mainnet. ` +
      "Enable Phantom Testnet Mode (Developer Settings), then fund Devnet SOL from a faucet."
    );
  }
  return msg;
}

/** If Devnet is empty but mainnet has SOL, the user is almost certainly on the wrong Phantom network. */
async function hintIfMainnetHasSol(owner: PublicKey, needLamports: number): Promise<string> {
  try {
    const main = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const mainBal = await main.getBalance(owner, "confirmed");
    if (mainBal >= needLamports) {
      return (
        " Phantom is funded on mainnet — this vault needs Devnet SOL. " +
        "Settings → Developer Settings → Testnet Mode → Solana Devnet, then use a Devnet faucet."
      );
    }
  } catch {
    /* ignore — mainnet probe is only for a clearer message */
  }
  return " Get Devnet SOL from https://faucet.solana.com (mainnet SOL does not work here).";
}

export async function signSendConfirm(
  phantom: PhantomLike,
  connection: Connection,
  tx: Transaction,
): Promise<string> {
  const depositor = new PublicKey(phantom.publicKey.toBytes());
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = depositor;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  try {
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = sim.value.logs?.slice(-8).join(" | ") ?? JSON.stringify(sim.value.err);
      throw new Error(`Transaction simulation failed: ${logs}`);
    }
  } catch (simErr) {
    if (simErr instanceof Error && simErr.message.startsWith("Transaction simulation failed:")) {
      throw simErr;
    }
    // Some RPCs reject simulate without signatures — continue to wallet send.
  }

  let signature: string;
  try {
    // signTransaction + sendRaw gives clearer RPC errors than Phantom signAndSend.
    const signed = await phantom.signTransaction(tx);
    signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (firstErr) {
    if (!phantom.signAndSendTransaction) throw new Error(formatSolanaSendError(firstErr));
    try {
      const sent = await phantom.signAndSendTransaction(tx);
      signature = sent.signature;
    } catch (secondErr) {
      throw new Error(formatSolanaSendError(secondErr ?? firstErr));
    }
  }
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

/**
 * Deposit Devnet USDC into the Siphon Solana vault via Phantom.
 */
export async function depositUsdcSolanaDevnet(params: {
  phantom: PhantomLike;
  amountBaseUnits: bigint;
  mint?: PublicKey;
}): Promise<SolanaNativeDepositResult> {
  if (params.amountBaseUnits <= 0n) throw new Error("Enter a valid USDC amount.");
  const connection = getDevnetConnection();
  const depositor = new PublicKey(params.phantom.publicKey.toBytes());
  const mint = params.mint ?? DEVNET_USDC_MINT;
  const userSalt = randomBytes32();
  const precommitment = randomBytes32();
  const { ix, commitment, note } = await buildDepositIx({
    depositor,
    amount: params.amountBaseUnits,
    userSalt,
    precommitment,
    mint,
  });

  const signature = await signSendConfirm(params.phantom, connection, new Transaction().add(ix));

  return {
    signature,
    commitmentHex: Array.from(commitment)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    notePubkey: note.toBase58(),
    amount: params.amountBaseUnits.toString(),
    chainId: SOLANA_DEVNET_CHAIN_ID,
    mint: mint.toBase58(),
  };
}

/**
 * Deposit native SOL: wrap to WSOL + vault deposit in one Phantom approval.
 * On-chain the vault only speaks SPL Token (WSOL mint), not raw lamports.
 */
export async function depositWsolSolanaDevnet(params: {
  phantom: PhantomLike;
  lamports: bigint;
}): Promise<SolanaNativeDepositResult> {
  if (params.lamports <= 0n) throw new Error("Enter a valid SOL amount.");
  if (params.lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount too large.");
  }
  const connection = getDevnetConnection();
  const depositor = new PublicKey(params.phantom.publicKey.toBytes());
  const balance = await connection.getBalance(depositor, "confirmed");
  const reserve = 50_000_000; // ~0.05 SOL: fees + ATA rent + headroom
  const need = Number(params.lamports) + reserve;
  if (balance < need) {
    const tip = await hintIfMainnetHasSol(depositor, need);
    throw new Error(
      `Not enough Devnet SOL: need ~${(need / 1e9).toFixed(4)} SOL ` +
        `(${(Number(params.lamports) / 1e9).toFixed(4)} deposit + ~0.05 SOL for fees/rent). ` +
        `Devnet balance ${(balance / 1e9).toFixed(4)} SOL.${tip}`,
    );
  }

  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, depositor);
  const userSalt = randomBytes32();
  const precommitment = randomBytes32();
  const { ix: depositIx, commitment, note } = await buildDepositIx({
    depositor,
    amount: params.lamports,
    userSalt,
    precommitment,
    mint: NATIVE_MINT,
  });

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      depositor,
      userWsol,
      depositor,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: depositor,
      toPubkey: userWsol,
      lamports: Number(params.lamports),
    }),
    createSyncNativeInstruction(userWsol),
    depositIx,
  );
  const signature = await signSendConfirm(params.phantom, connection, tx);

  return {
    signature,
    commitmentHex: Array.from(commitment)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    notePubkey: note.toBase58(),
    amount: params.lamports.toString(),
    chainId: SOLANA_DEVNET_CHAIN_ID,
    mint: NATIVE_MINT.toBase58(),
  };
}

/** Anchor `NoteAccount` byte length (8-byte disc + InitSpace fields). */
const NOTE_ACCOUNT_DATA_LEN = 218;

function parseUnspentNoteAmount(
  data: Buffer,
  depositor: PublicKey,
): { symbol: "SOL" | "USDC" | "jlUSDC" | "JitoSOL"; amount: bigint } | null {
  if (data.length < NOTE_ACCOUNT_DATA_LEN) return null;
  const noteDep = new PublicKey(data.subarray(9, 41));
  if (!noteDep.equals(depositor)) return null;
  const spent = data[NOTE_ACCOUNT_DATA_LEN - 1] !== 0;
  if (spent) return null;
  const mint = new PublicKey(data.subarray(41, 73));
  const amount = data.readBigUInt64LE(73);
  if (mint.equals(NATIVE_MINT)) return { symbol: "SOL", amount };
  if (mint.equals(DEVNET_USDC_MINT)) return { symbol: "USDC", amount };
  if (mint.equals(DEVNET_JL_USDC_MINT)) return { symbol: "jlUSDC", amount };
  return null;
}

/**
 * Sum unspent vault notes for a Phantom depositor (on-chain private balance on Devnet).
 */
export async function fetchSolanaDevnetPrivateBalances(depositorAddress: string): Promise<{
  deposited: Record<string, number>;
}> {
  const connection = getDevnetConnection();
  const depositor = new PublicKey(depositorAddress);
  const accounts = await connection.getProgramAccounts(SIPHON_VAULT_PROGRAM_ID, {
    filters: [
      { dataSize: NOTE_ACCOUNT_DATA_LEN },
      { memcmp: { offset: 9, bytes: depositor.toBase58() } },
    ],
  });
  const deposited: Record<string, number> = {};
  for (const { account } of accounts) {
    const row = parseUnspentNoteAmount(account.data, depositor);
    if (!row) continue;
    const decimals = row.symbol === "SOL" ? 9 : 6;
    const human = Number(row.amount) / 10 ** decimals;
    if (!Number.isFinite(human) || human <= 0) continue;
    deposited[row.symbol] = (deposited[row.symbol] ?? 0) + human;
  }
  return { deposited };
}

/** Server-side init helper (Node keypair). */
export async function initializeVaultWithKeypair(params: {
  payer: Keypair;
  mint?: PublicKey;
}): Promise<string> {
  const connection = getDevnetConnection();
  const ix = await buildInitializeVaultIx({
    authority: params.payer.publicKey,
    mint: params.mint,
  });
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [params.payer], {
    commitment: "confirmed",
  });
}

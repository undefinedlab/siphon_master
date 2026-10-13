import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = web3;
const { getAssociatedTokenAddressSync, getAccount } = spl;

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_RELAYER_KEYPAIR)));
const c = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const usdc = new PublicKey(process.env.JUPITER_EARN_ASSET_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const jl = new PublicKey(process.env.JUPITER_JL_USDC_MINT || "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");

async function tok(mint) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
    const a = await getAccount(c, ata);
    return { ata: ata.toBase58(), amount: a.amount.toString() };
  } catch (e) {
    return { amount: "0", err: String(e?.message || e) };
  }
}

const out = {
  payer: kp.publicKey.toBase58(),
  sol: (await c.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL,
  lamports: await c.getBalance(kp.publicKey),
  usdc: await tok(usdc),
  jlusdc: await tok(jl),
  pool: process.env.METEORA_JLUSDC_SOL_POOL,
};
console.log(JSON.stringify(out, null, 2));

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = web3;
const { getAssociatedTokenAddressSync, getAccount } = spl;

const p = path.join(os.homedir(), ".config", "solana", "id.json");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const c = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const usdc = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const jl = new PublicKey("2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");

async function tok(mint) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
    const a = await getAccount(c, ata);
    return { ata: ata.toBase58(), amount: a.amount.toString() };
  } catch (e) {
    return { amount: "0", err: String(e?.message || e) };
  }
}

console.log(JSON.stringify({
  payer: kp.publicKey.toBase58(),
  keyPath: p,
  sol: (await c.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL,
  usdc: await tok(usdc),
  jlusdc: await tok(jl),
}, null, 2));

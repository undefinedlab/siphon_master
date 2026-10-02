/**
 * One-shot: convert staged Circle USDC (4zMMC9) on the relayer to vault USDC (DteUan)
 * via HjpPx (Circle↔WSOL) then BY4c (WSOL↔DteUan). Prints {ok, amount_out, mint_out}.
 */
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const dlmmMod = require("@meteora-ag/dlmm");
const DLMM = dlmmMod.default || dlmmMod;
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const BN = require("bn.js");

const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = web3;
const {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} = spl;

const CIRCLE = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const DTEU = new PublicKey("DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const HJP = new PublicKey("HjpPxUVfHe7GWtj1LkQaH3Dyj8Xbi548pQBNzq1v7ADd");
const BY4 = new PublicKey("BY4cLgYMpE1AA5X5jiXHEMTrVkG7uhDvr6KxjU8YfCEZ");

function loadKeypair() {
  const raw = process.env.SOLANA_RELAYER_KEYPAIR || process.env.SOLANA_KEYPAIR;
  if (!raw) throw new Error("SOLANA_RELAYER_KEYPAIR unset");
  const parsed = JSON.parse(raw.startsWith("[") ? raw : fs.readFileSync(raw, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

async function bal(connection, ata) {
  try {
    return (await getAccount(connection, ata)).amount;
  } catch {
    return 0n;
  }
}

async function swapExact(connection, payer, poolPk, inMint, outMint, amountIn, slippageBps = 200) {
  const pool = await DLMM.create(connection, poolPk, {
    cluster: "devnet",
    skipSolWrappingOperation: true,
  });
  const outAta = getAssociatedTokenAddressSync(outMint, payer.publicKey, true);
  const setup = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      outAta,
      payer.publicKey,
      outMint,
    ),
  );
  await sendAndConfirmTransaction(connection, setup, [payer], { commitment: "confirmed" });
  const before = await bal(connection, outAta);
  const swapForY = inMint.equals(pool.tokenX.publicKey);
  const bins = await pool.getBinArrayForSwap(swapForY, 4);
  const q = await pool.swapQuote(new BN(amountIn.toString()), swapForY, new BN(slippageBps), bins, false);
  const swapTx = await pool.swap({
    inToken: inMint,
    outToken: outMint,
    inAmount: new BN(amountIn.toString()),
    minOutAmount: q.minOutAmount,
    lbPair: pool.pubkey,
    user: payer.publicKey,
    binArraysPubkey: q.binArraysPubkey,
  });
  const sig = await sendAndConfirmTransaction(connection, swapTx, [payer], { commitment: "confirmed" });
  const got = (await bal(connection, outAta)) - before;
  if (got <= 0n) throw new Error(`swap ${sig} produced 0 ${outMint.toBase58()}`);
  return { sig, amount_out: got };
}

async function main() {
  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const payer = loadKeypair();
  console.error("payer", payer.publicKey.toBase58());
  const circleAta = getAssociatedTokenAddressSync(CIRCLE, payer.publicKey, true);
  const circleBal = await bal(connection, circleAta);
  if (circleBal === 0n) {
    const dteuAta = getAssociatedTokenAddressSync(DTEU, payer.publicKey, true);
    const dteuBal = await bal(connection, dteuAta);
    console.log(JSON.stringify({ ok: true, skipped: true, amount_out: dteuBal.toString(), mint_out: DTEU.toBase58() }));
    return;
  }
  const toWsol = await swapExact(connection, payer, HJP, CIRCLE, WSOL, circleBal);
  const toDteu = await swapExact(connection, payer, BY4, WSOL, DTEU, toWsol.amount_out);
  console.log(
    JSON.stringify({
      ok: true,
      amount_out: toDteu.amount_out.toString(),
      mint_out: DTEU.toBase58(),
      circle_to_wsol: toWsol.sig,
      wsol_to_dteu: toDteu.sig,
    }),
  );
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});

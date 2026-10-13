/**
 * Probe jlUSDC→SOL DLMM quotes at small sizes.
 *   node probe-jlusdc-sol-quote.mjs [amountBaseUnits...]
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm").default || require("@meteora-ag/dlmm");
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

const POOL = new PublicKey(
  process.env.METEORA_JLUSDC_SOL_POOL || "5fMCqmsc1iGJFLtvQJxrWb4zEENLo9U8EVo97KKktJCE",
);
const JLUSDC = new PublicKey("2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");
const amounts = (process.argv.slice(2).length ? process.argv.slice(2) : ["1000", "10000", "50000", "100000", "247444"]).map(
  (x) => BigInt(x),
);

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const pool = await DLMM.create(connection, POOL, { cluster: "devnet", skipSolWrappingOperation: true });
await pool.refetchStates();
const tokenX = pool.tokenX.publicKey;
const tokenY = pool.tokenY.publicKey;
const swapForY = JLUSDC.equals(tokenX);
console.log(
  JSON.stringify({
    pool: POOL.toBase58(),
    tokenX: tokenX.toBase58(),
    tokenY: tokenY.toBase58(),
    swapForY,
    activeId: pool.lbPair.activeId,
    binStep: pool.lbPair.binStep,
  }),
);

const bins = await pool.getBinArrayForSwap(swapForY, 8);
for (const amount of amounts) {
  try {
    const q = await pool.swapQuote(new BN(amount.toString()), swapForY, new BN(100), bins, false);
    console.log(
      JSON.stringify({
        amountIn: amount.toString(),
        ok: true,
        out: q.outAmount.toString(),
        consumed: q.consumedInAmount.toString(),
        full: BigInt(q.consumedInAmount.toString()) >= amount,
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ amountIn: amount.toString(), ok: false, error: String(e?.message || e) }));
  }
}

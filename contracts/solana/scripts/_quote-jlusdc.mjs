import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm").default || require("@meteora-ag/dlmm");
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

const POOL = new PublicKey(process.env.METEORA_JLUSDC_SOL_POOL || "5fMCqmsc1iGJFLtvQJxrWb4zEENLo9U8EVo97KKktJCE");
const c = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const pool = await DLMM.create(c, POOL, { cluster: "devnet" });
await pool.refetchStates();
console.log("X", pool.tokenX.publicKey.toBase58(), "Y", pool.tokenY.publicKey.toBase58());
console.log("activeId", pool.lbPair.activeId, "reserveX", pool.lbPair.reserveX?.toString?.(), "reserveY", pool.lbPair.reserveY?.toString?.());

const amt = new BN(process.env.QUOTE_AMOUNT || "197955");
for (const swapForY of [false, true]) {
  try {
    const bins = await pool.getBinArrayForSwap(swapForY);
    const q = await pool.swapQuote(amt, swapForY, new BN(5000), bins, false);
    console.log(
      `swapForY=${swapForY}`,
      "in", amt.toString(),
      "out", q.outAmount?.toString?.(),
      "fee", q.fee?.toString?.(),
      "priceImpact", q.priceImpact?.toString?.(),
    );
  } catch (e) {
    console.log(`swapForY=${swapForY} FAIL`, e?.message || e);
  }
}

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm").default || require("@meteora-ag/dlmm");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const BN = require("bn.js");

const POOL = new PublicKey("5fMCqmsc1iGJFLtvQJxrWb4zEENLo9U8EVo97KKktJCE");
const c = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))),
);
const pool = await DLMM.create(c, POOL, { cluster: "devnet" });
await pool.refetchStates();
console.log({
  activeId: pool.lbPair.activeId,
  binStep: pool.lbPair.binStep,
  X: pool.tokenX.publicKey.toBase58(),
  Y: pool.tokenY.publicKey.toBase58(),
  sol: await c.getBalance(payer.publicKey),
});
const { userPositions } = await pool.getPositionsByUserAndLbPair(payer.publicKey);
console.log(
  "positions",
  userPositions.map((p) => ({
    pk: p.publicKey.toBase58(),
    lower: p.positionData.lowerBinId,
    upper: p.positionData.upperBinId,
    x: p.positionData.totalXAmount?.toString?.(),
    y: p.positionData.totalYAmount?.toString?.(),
  })),
);

for (const swapForY of [false, true]) {
  for (const count of [1, 4, 8]) {
    try {
      const bins = await pool.getBinArrayForSwap(swapForY, count);
      const q = await pool.swapQuote(new BN("197955"), swapForY, new BN(5000), bins, false);
      console.log(`ok swapForY=${swapForY} count=${count} out=${q.outAmount.toString()}`);
    } catch (e) {
      console.log(`fail swapForY=${swapForY} count=${count}: ${e.message}`);
    }
  }
}

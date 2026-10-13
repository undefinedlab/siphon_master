import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm").default || require("@meteora-ag/dlmm");
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const BN = require("bn.js");

const POOL = new PublicKey("5fMCqmsc1iGJFLtvQJxrWb4zEENLo9U8EVo97KKktJCE");
const c = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))),
);
console.log("payer", payer.publicKey.toBase58(), "sol", await c.getBalance(payer.publicKey));

const pool = await DLMM.create(c, POOL, { cluster: "devnet" });
await pool.refetchStates();
const activeId = pool.lbPair.activeId;
const center = Math.floor(activeId / 70);
// Wider than ±1 — sell-Y walks bin arrays in the opposite direction from sell-X.
const indexes = [];
for (let i = center - 3; i <= center + 3; i++) indexes.push(new BN(i));
console.log("activeId", activeId, "indexes", indexes.map((b) => b.toString()).join(","));

const initIxs = await pool.initializeBinArrays(indexes, payer.publicKey);
console.log("ix count", initIxs.length);
if (initIxs.length) {
  // May need multiple txs if too many ixs.
  const chunk = 3;
  for (let i = 0; i < initIxs.length; i += chunk) {
    const slice = initIxs.slice(i, i + chunk);
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(...slice), [payer], {
      commitment: "confirmed",
    });
    console.log("binArray tx", sig);
  }
}

await pool.refetchStates();
for (const swapForY of [false, true]) {
  try {
    const bins = await pool.getBinArrayForSwap(swapForY, 8);
    const q = await pool.swapQuote(new BN("197955"), swapForY, new BN(5000), bins, false);
    console.log(`QUOTE swapForY=${swapForY} out=${q.outAmount.toString()} fee=${q.fee.toString()}`);
  } catch (e) {
    console.log(`QUOTE swapForY=${swapForY} FAIL ${e.message}`);
  }
}

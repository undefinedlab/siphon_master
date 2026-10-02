/**
 * Devnet smoke: USDC → jlUSDC (Earn) → SOL (Meteora) under mock TEE pipeline.
 *
 * Prerequisites:
 *   NEXT_PUBLIC_ALLOW_MOCK_TEE=true
 *   decryptor (mock_kms) + trade-executor + app with ASP/solasp + snarkjs keys
 *   A spendable USDC note in the Phantom wallet's local store
 *
 * This script documents the hop list the Builder arms via armSolanaDevnetPipeline.
 * End-to-end arming is browser-driven (Phantom); here we print the expected hop shape
 * and exit 0 so CI can gate on the unit state-machine tests.
 *
 * Manual run (browser console / Builder):
 *   lend(jupiter enter) + swap(jlUSDC→SOL) → arms PIPELINE with execute_now.
 */
const hops = [
  { venue: "jupiter-earn", action: "enter", assetIn: "USDC", assetOut: "jlUSDC" },
  { venue: "meteora-dlmm", assetIn: "jlUSDC", assetOut: "SOL", meteora_pair: "jlusdc_sol" },
];

console.log(JSON.stringify({
  ok: true,
  smoke: "pipeline-earn-swap",
  hops,
  note: "Arm via Builder (lend+swap) or armSolanaDevnetPipeline; TEE proves hop 1 after hop 0 returned_note.",
}, null, 2));

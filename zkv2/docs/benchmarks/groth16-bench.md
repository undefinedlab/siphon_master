# Circom Groth16 prove times (siphon-zkv2)

Host: 8× i9-12900K, 15 GB RAM. Dev-beacon zkeys.

## PROTOCOL circuits (25-limb, ASP + SMT)

| Circuit | NL constraints (approx) | snarkjs prove (this host) |
| --- | --- | --- |
| **withdraw1** | ~26k | **~2.2 s** |
| withdraw2 / withdraw3 | ~51k / ~76k | scales ~linearly with N |
| **merge2** | ~51k | ~2× withdraw1 |
| merge3…6 | ~76k…~152k | |
| swap / split / ragequit | ~27–34k | |

Optimizations: per-N withdraw/merge (no 6-slot padding) + SMT MSB-32 split (not `Num2Bits(254)`).

## Faster prover (rapidsnark)

Witness stays **circom wasm + snarkjs**; only the Groth16 prove step can use native rapidsnark (~2–5× faster on large circuits).

```bash
# Build iden3/rapidsnark → point at prover binary
export RAPIDSNARK_PROVER=/path/to/rapidsnark/build/prover

npm run bench:prove -- withdraw1              # snarkjs + rapidsnark if available
npm run bench:prove -- withdraw1 --backend snarkjs

npm run prove:groth16 -- --circuit withdraw1 --input witness.json --backend rapidsnark
```

Helper: `scripts/lib/groth16-prove.cjs` (`proveGroth16`, `circuitKeyForAction` in `circuits.cjs`).

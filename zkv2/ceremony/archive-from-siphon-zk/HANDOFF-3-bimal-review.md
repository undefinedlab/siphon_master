# Ceremony review — Bimal (independent reviewer)

You are the **non-participant reviewer**. You did not contribute entropy, and you must not: your
value here is that you are independent of every contribution.

Contributors this round: **swarnim** (round_0001), **aadi** (round_0002), then a public beacon.
Circuits frozen at `siphon-zk` commit `40e3d15`.

## What you receive

- `ceremony/final/` — 14 `*_final.zkey`, `beacon.txt`, `SHA256SUMS`
- `ceremony/r1cs/` — the 14 `.r1cs` the ceremony was run against
- `transcript.tar.gz` — contribution receipts from every round.
  **Treat these receipts as unverified.** They are assembled by the coordinator, who is also a
  contributor. Obtain each contributor's receipt from that person directly (see check 1).
- `hard-asp-manifest.json`
- `scripts/mpc_phase2.sh`
- phase-1 ptau `powersOfTau28_hez_final_20.ptau`
  (sha256 `159d3f938d941e06767d99f30b9fe59a245400a4aae138cf8e411732d7a2f6cd`)

Fetch the ptau yourself from the Hermez source rather than trusting the copy sent to you, then
confirm the hash matches the line above.

## Step 1 — independent verification

```bash
PTAU=/path/to/powersOfTau28_hez_final_20.ptau ./scripts/mpc_phase2.sh verify
```

This re-derives every circuit from `r1cs + ptau + final.zkey` and prints the full contribution chain.
All 14 must report `ZKey Ok`.

## Step 2 — the four checks that actually matter

The script cannot do these for you. They are the review.

1. **Contribution chain — the check the coordinator cannot fake. Do this one properly.**

   Note who the coordinator is: he also ran contribution #1. So *one* person authored `round_0000`,
   holds every round directory, writes `transcript.tar.gz`, and contributed. If he had also produced
   round_0002 himself under the name "aadi", he would hold every secret and could forge any
   withdrawal proof, forever. Aadi's genuine participation is the entire guarantee. **Your job is to
   confirm it independently of the coordinator.**

   `./scripts/mpc_phase2.sh verify` is **not sufficient** for this. Its output is piped through
   `grep -iE "contribution|beacon|ZKey Ok"`, and snarkjs prints contribution hashes as four
   tab-indented hex lines containing none of those words — so the filter throws away the hashes and
   leaves only a name string, which the coordinator typed himself via `--name=`.

   Run it unfiltered instead, per circuit:

   ```bash
   snarkjs zkey verify ceremony/r1cs/main_<c>.r1cs "$PTAU" ceremony/final/<c>_final.zkey 2>&1 \
     | grep -A4 -iE 'contribution #'
   ```

   Then get each `receipt_round000N_<name>.txt` **directly from that contributor** — phone them, have
   them upload it themselves, any channel the coordinator does not relay. Do **not** use the copies
   in `transcript.tar.gz`; those are the coordinator's own bundle and prove nothing about who ran what.

   Match the four-line `Contribution Hash` blocks from each contributor's own receipt against your
   unfiltered `verify` output, for all 14 circuits. They must be byte-identical. While you have each
   contributor on the phone, confirm they generated real entropy and destroyed it.

   Finally: exactly two human contributions then the beacon — none extra, none missing.

2. **Beacon is genuinely public and was PRE-announced.** `beacon.txt` records a block height and
   hash. Look that block hash up yourself on a block explorer. Confirm it matches, **and** confirm
   the announcement predates the block. A beacon chosen after the fact voids the whole ceremony —
   this is the single most important check you perform.

3. **Circuit provenance.** The `.r1cs` correspond to the frozen circuits. Recompile from
   `siphon-zk@40e3d15` yourself and compare, if you want the strongest form of this check.
   Expected public-signal counts: `w1..w6` = 7,8,9,10,11,12 · `m2..m6` = 6,7,8,9,10 ·
   `swap` = 11 · `split` = 12 · `ragequit` = 6.

4. **Verifier ↔ zkey pairing.** Each exported Solidity verifier embeds an `IC0` constant derived
   from its zkey. Confirm the deployed verifier's `IC0` matches the ceremony zkey for that circuit.
   This is the check that catches a mismatched or swapped artifact reaching production.

## Step 3 — sign off

Only if all four pass:

- flip `ceremony.status` to `"reviewed"` in `hard-asp-manifest.json`
- approve the manifest SHA-256 **out-of-band** — not through this repo, not through the server that
  will serve the artifacts

If anything fails, say so and stop. A failed ceremony that gets redone costs days. A bad ceremony
that ships is unbounded: anyone holding the toxic waste can mint proofs against real funds forever,
undetectably.

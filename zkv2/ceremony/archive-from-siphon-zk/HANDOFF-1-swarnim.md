# Ceremony handoff 1 of 2 — Swarnim (contributor #1)

You are the **first** contributor. Circuits are frozen at `siphon-zk` commit `40e3d15`.

## What you have

`round_0000/` already exists on this machine at
`/Users/swarnimraj/Siphon/siphon-zk/ceremony/round_0000/` — you do **not** need the tarball.

## Run it

```bash
cd /Users/swarnimraj/Siphon/siphon-zk/ceremony
./round_0000/mpc_contribute.sh swarnim round_0000
```

It will:

1. verify `SHA256SUMS` of the incoming round (must pass before it proceeds),
2. prompt you to type random characters — **mash the keyboard properly**, this is the entropy,
3. contribute to all 14 circuits (~30–90 min, mostly unattended),
4. write `round_0001/` with a receipt and a fresh `SHA256SUMS`.

Your typed entropy is mixed with fresh OS randomness per circuit, is never displayed, and is never
written to disk. Close the terminal when done. **Do not record what you typed anywhere.**

## When it finishes

Send `round_0001/` (whole directory) to Aadi, and send its digest **over a different channel**:

```bash
shasum -a 256 round_0001/SHA256SUMS
```

If the file goes via Drive, send the digest via Signal. Sending both the same way proves nothing.

## Why this matters

The security of the entire system rests on **at least one** contributor having generated real
randomness and destroyed it. If you and Aadi both did that honestly, no one — including anyone who
compromises the other participant — can forge proofs.

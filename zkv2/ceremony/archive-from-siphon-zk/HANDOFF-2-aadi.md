# Ceremony handoff 2 of 2 — Aadi (contributor #2)

You are the **second and final** human contributor to the Siphon Hard ASP phase-2 trusted setup.
After you, a pre-announced public beacon is applied and the ceremony closes.

## Requirements

macOS or Linux · Node.js 18+ · ~8 GB free RAM · ~10 GB free disk · ~30–90 min (mostly unattended)

## What you receive

- `round_0001/` — a directory of 14 `.zkey` files produced by contributor #1, plus
  `mpc_contribute.sh`, `ROUND` and `SHA256SUMS`
- separately, **via a different channel**, the SHA-256 of `round_0001/SHA256SUMS`

## Step 1 — verify before you contribute

```bash
cd round_0001
shasum -a 256 SHA256SUMS          # must equal the digest sent to you separately
shasum -a 256 -c SHA256SUMS       # must be 15/15 OK
```

**If either check fails, STOP and tell the coordinator. Do not contribute.** A mismatch means the
package was altered in transit, and contributing on top of it would launder the tampering.

## Step 2 — contribute

```bash
cd ..
./round_0001/mpc_contribute.sh aadi round_0001
```

It prompts you to type random characters. Mash the keyboard — letters, digits, whatever, for a good
while. That entropy is combined with fresh OS randomness for each of the 14 circuits, is never
printed, and is never written to disk.

## Step 3 — return

Send the entire `round_0002/` directory back to the coordinator, and its digest **over a different
channel than the files**:

```bash
shasum -a 256 round_0002/SHA256SUMS
```

## Step 4 — destroy your entropy

Close the terminal. Do not save, screenshot, or message what you typed. Ever.

The guarantee is: as long as **at least one** contributor generated real randomness and destroyed
it, nobody can forge a proof — not the other contributor, not the coordinator, not someone who later
compromises every machine involved. You are one of the two people that guarantee rests on.

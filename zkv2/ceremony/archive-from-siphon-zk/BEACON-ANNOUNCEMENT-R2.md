# Siphon Hard ASP phase-2 ceremony — R2 public beacon announcement

**This file is published BEFORE the beacon value exists. That is the entire point.**

Round 2 supersedes Round 1 (`BEACON-ANNOUNCEMENT.md`, block 25791557) for the greedy-label constraint system (commit `b25aca3` lineage).

## The beacon

| | |
|---|---|
| Source | Ethereum **mainnet** block hash |
| Block height | **25798026** |
| Pre-announced at | 2026-08-20T17:59:53Z |
| Block mined at | 2026-08-20T18:08:23Z |
| Beacon hex | `166646970b9fa85b7db581ad846f4cc46e104733fd04fafdccbbc484de0b7153` |
| Applied with | `snarkjs zkey beacon … 10` (2^10 iterations) |

The hash of Ethereum mainnet block `25798026` is used, verbatim and with no `0x` prefix, as the
final contribution to all 14 circuits of the Siphon Hard ASP phase-2 trusted setup (Round 2).

## Ceremony parameters

| | |
|---|---|
| Circuits | 14 — `w1`–`w6`, `m2`–`m6`, `swap`, `split`, `ragequit` |
| Phase 1 | Hermez `powersOfTau28_hez_final_20.ptau` |
| Contributors | swarnim (round_0001), aadi (round_0002) |
| Reviewer (non-participant) | bimal |
| Live manifest | `siphon-app/public/zk/CEREMONY.json` (`hard-asp-r2-05c45199b51de2b0`) |

Expected public-signal counts after OMEGA V5 circuit fixes (recompile before next ceremony round):
`w1..w6` = 8,9,10,11,12,13 · `m2..m6` = 7,8,9,10,11 · `swap` = 13 · `split` = 12 · `ragequit` = 6

Pre-fix R2 keys (currently in app): `w1..w6` = 7..12 · `m2..m6` = 6..10 · `swap` = 11 · `split` = 12 · `ragequit` = 6

## How to verify this was honest

1. Confirm the **commit timestamp of this file predates** block 25798026 (use GitHub push time as authoritative).
2. Look up the hash of block 25798026 on any block explorer.
3. Confirm it matches `CEREMONY.json` → `beacon.hex` and `ceremony/final/beacon.txt` (if present locally).
4. Run `./scripts/mpc_phase2.sh verify` and confirm the full contribution chain including hash blocks.

## OpenTimestamps

`ceremony/BEACON-ANNOUNCEMENT-R2.md.ots` — Bitcoin OpenTimestamps proof anchoring this announcement
before block 25798026 existed. Generate with:

```bash
ots stamp ceremony/BEACON-ANNOUNCEMENT-R2.md
```

Until the `.ots` file is committed, `CEREMONY.json` retains `beacon-provenance-waived` caveat.

## Note on ordering

The beacon is applied strictly last, after both human contributions. Because the announced block may
be mined before contribution rounds finish, participants may know the beacon value while contributing.
This does not weaken the guarantee: nobody could *choose* or *influence* the beacon.

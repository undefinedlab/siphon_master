# Siphon Hard ASP phase-2 ceremony — public beacon announcement

**This file is published BEFORE the beacon value exists. That is the entire point.**

## The beacon

| | |
|---|---|
| Source | Ethereum **mainnet** block hash |
| Block height | **25791557** |
| Announced at | 2026-08-19T20:21:09Z |
| Chain height when announced | 25791507 (i.e. 50 blocks / ~10 minutes in the future) |
| Applied with | `snarkjs zkey beacon … 10` (2^10 iterations) |

The hash of Ethereum mainnet block `25791557` will be used, verbatim and with no `0x` prefix, as the
final contribution to all 14 circuits of the Siphon Hard ASP phase-2 trusted setup.

At the time this commit was authored, block 25791557 did not exist and its hash was unknown to every
participant, to the coordinator, and to the reviewer. Nobody chose this value.

## Ceremony parameters

| | |
|---|---|
| Circuits | 14 — `w1`–`w6`, `m2`–`m6`, `swap`, `split`, `ragequit` |
| Circuit source | `siphon-zk` commit `40e3d15` (frozen) |
| Phase 1 | Hermez `powersOfTau28_hez_final_20.ptau` |
| Phase 1 sha256 | `159d3f938d941e06767d99f30b9fe59a245400a4aae138cf8e411732d7a2f6cd` |
| `round_0000` manifest sha256 | `0451f5982e4180dd5623bd36bff832f8a4fe2f74b13f28a6ef9cbda7aab94eb2` |
| Contributors | swarnim (round_0001), aadi (round_0002) |
| Reviewer (non-participant) | bimal |

Expected public-signal counts, for independent recompilation:
`w1..w6` = 7,8,9,10,11,12 · `m2..m6` = 6,7,8,9,10 · `swap` = 11 · `split` = 12 · `ragequit` = 6

## How to verify this was honest

1. Confirm the **commit timestamp of this file predates** the timestamp of block 25791557.
   Git commit dates are author-supplied and can be forged; use the GitHub push/commit event time,
   which the author does not control, as the authoritative record.
2. Look up the hash of block 25791557 on any block explorer yourself.
3. Confirm `ceremony/final/beacon.txt` records exactly that hash.
4. Confirm the beacon was applied **after** both human contributions — `mpc_phase2.sh` refuses to
   apply a beacon below round 2, and `snarkjs zkey verify` prints the full ordered contribution
   chain.

If the beacon in `beacon.txt` does not match block 25791557, or if this announcement does not
predate the block, **the ceremony is void and must be redone.**

## Note on ordering

The beacon is applied strictly last, after both human contributions, and this is enforced by the
coordinator script rather than by convention. Because the announced block may be mined before the
contribution rounds finish, participants may know the beacon value while contributing. This does not
weaken the guarantee: the security property is that no participant could *choose* or *influence* the
beacon, and a pre-committed future block hash satisfies that regardless of when contributions
complete. The residual assumption remains the standard one — at least one contributor generated real
randomness and destroyed it.

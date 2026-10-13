# Ceremony

Production Groth16 keys for siphon-zkv2 are produced here — **not** checked into git.

1. Coordinator: `./scripts/mpc-phase2.sh init`
2. Contributors: `./scripts/mpc-contribute.sh <name> round_XXXX`
3. Pre-announce beacon block hash publicly, then `./scripts/mpc-phase2.sh beacon …`
4. `./scripts/mpc-phase2.sh finalize ../siphon-contracts-v2/evm`
5. Independent reviewer: `./scripts/mpc-phase2.sh verify`

Round directories, ptau, and final zkeys are gitignored. Publish transcript + manifest SHA out-of-band after review.

## Archive from siphon-zk

Past beacon announcements and contributor handoffs (process reference only):

[`archive-from-siphon-zk/`](./archive-from-siphon-zk/)

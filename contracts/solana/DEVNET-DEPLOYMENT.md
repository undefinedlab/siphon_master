# Devnet ZK vault — deployment record

Our own deployment of `programs/siphon-vault-zk` on Solana devnet, replacing `F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH`
(whose upgrade key we do not hold). Deployed 2026-10-09.

## Addresses

| What | Address |
|---|---|
| Program | `BktHHQ8KJpfnwLNMEqnh9uANEyuFa1qYtbhzHwCKMEDe` |
| ProgramData | `CfVckFYxijm62PPATh57XphhQm8SANA9LVaWYhtSnRKk` |
| Upgrade authority = vault authority | `85CjK8zsHgwZpwkWghsqHM74ThY6DNVr5rhi93beCUsG` |
| Vault PDA (`siphon-vault-v1`) | `9ndUc4FN7djmULrsJxKiVhcaxfQciXBRQcFJc9rWQb9G` |
| Tree PDA (`siphon-tree-v1`) | `7c6F4mNgQRSNmit6feAgJLx1HFojNQTnEDiSoc2dEoxn` |
| Compliance PDA (`siphon-compliance-v1`) | `42r85DiU5wV1PM2oYy9gt85Z6S8fcihYp1bWvL3xH4cT` |
| Postman config PDA | `5ym6e5XQFJC8TaabJsSde44KYEaZ4511ihigp2UpgKwj` |
| Postman (solasp) | `5RovhnQbzGyEBofjQpBa1qi6Wh7SsZztTZMWAE24poGq` |
| Allowed mint (devnet USDC) | Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (+ wSOL); was `DteUan…` until 2026-10-09 |
| Meteora DLMM pool (wSOL/USDC) | `HjpPxUVfHe7GWtj1LkQaH3Dyj8Xbi548pQBNzq1v7ADd` (Circle USDC, bin step 10; fills ~0.1 SOL sells / ~165 USDC buys as of 2026-10-09); was `BY4cLgYM…` (~2.3 USDC deep) |
| Executor settlement wallet | `8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg` |

Program version limb: 5. Verifying keys: the 14 dev-beacon VKs copied byte for byte from the old program's
VK PDAs (they match the app's `/zk` proving keys); slots 0–13 = withdraw1–6, merge2–6, swap, split, ragequit.

## Keys

Not in any repo. On Swarnim's laptop, `chmod 600`:

- `~/.config/solana/siphon-devnet-deployer.json` — upgrade + vault authority. Losing it means the program can
  never be upgraded and no VK or postman can be changed.
- `~/.config/solana/siphon-devnet-program.json` — program keypair; only the first deploy needed it.

## Changes from the old program

- **USDC withdraw**: a note's asset limb is the mint reduced mod p; devnet USDC is ~3p, so it read back as
  `47wdgm…` and every USDC withdraw failed `MintNotAllowed`. Withdraw now matches reduced forms (`payout_mint`).
- **Admitted-root ring (128)**: a spend may cite any recently published admitted root, but only the current
  revoked root. Before, every admission invalidated every armed order's proof.
- **State-root ring 64 → 250** (the 10 KiB a CPI `init` may allocate).
- `ComplianceAccount` is zero-copy (its ring overflowed the 4 KiB SBF stack frame); layout unchanged for the
  first two roots.
- `set_compliance` is `init` (bootstrap only); roots afterwards come from `publish_roots`.
- **`spend_split`** (upgrade 2026-10-09, slot 508907747; program account extended by 20000 bytes first):
  one note into up to 8 slices under its label, for multi-leg orders (TWAP / DCA / grid). Split VK slot 12,
  one input; the 8 commitments are re-hashed to the proof's MerkleRoot8 (limb 17) before insertion.
- **`set_allowed_mint`** (upgrade 2026-10-09, slot 508916293): authority re-points the vault's SPL mint, only
  while the vault's ATA for the current mint is empty or absent. Used once: `DteUan…` → Circle devnet USDC
  (tx `3iQzCYDm…`), because only Hugo's wallet could mint `DteUan…` and its one pool held ~2.3 USDC.

## Build and upgrade

Agave CLI (Homebrew `solana` has no `cargo-build-sbf`), platform tools v1.54:

```sh
export PATH=~/.local/share/solana/install/active_release/bin:$PATH
cd programs/siphon-vault-zk && cargo-build-sbf --tools-version v1.54 --sbf-out-dir ../../target/deploy
K=~/.config/solana/siphon-devnet-deployer.json
solana program deploy ../../target/deploy/siphon_vault_zk.so --program-id BktHHQ8KJpfnwLNMEqnh9uANEyuFa1qYtbhzHwCKMEDe \
  --keypair $K --upgrade-authority $K --url devnet --max-sign-attempts 100
```

Check a clean build for `overflows the maximum allowed frame space` — the build only warns, and the program then
crashes at runtime. Public devnet RPC rate-limits `--use-rpc` buffer writes; the default send path works.

Bootstrap order for a fresh vault (all with `SOLANA_KEYPAIR="$(cat $K)"` and
`NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID=<program>`): `init-vault-devnet-zk.mjs`, `upload-vk-devnet.mjs`
(`VK_DIR=…`), `set-postman-devnet.mjs <postman>` (also creates the compliance account).

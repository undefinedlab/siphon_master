# Siphon MCP server (`siphon-mcp`)

This is the MCP server that gives Claude Code, Codex and other MCP clients a private vault on **Solana Devnet** (chain 900002). It's for maintainers; users see [`packages/mcp/README.md`](../packages/mcp/README.md) on npm, the dashboard's **API** tab (Devnet), and docs.siphon.money → API.

- **Source:** [`packages/mcp/src`](../packages/mcp/src). It's built on the v5 SDK's Solana module ([`packages/sdk-ts/src/solana`](../packages/sdk-ts/src/solana)).
- **Legacy:** `packages/sdk-ts/src/mcp.ts` is the old v1 server and calls the retired Entrypoint API. It's kept only because something outside this repo may still run it. Don't extend it.

## Design

| Decision | Why |
|---|---|
| Local stdio server, published on npm | It has to sign with the user's wallet and prove locally. A hosted server can't hold either. |
| Devnet only | Users run an agent with a wallet in reach. Test tokens keep that safe. |
| Its own wallet by default (`~/.siphon-mcp/devnet-wallet.json`) | `~/.config/solana/id.json` may be a real wallet. |
| Claims its own free key and opens its account on first use | Setup is one command. |
| Atomic, 0600 state file per wallet (`~/.siphon-mcp/devnet/<wallet>.json`), written before any transaction | Note secrets are the only way to spend the balance. |
| Orders spend their notes directly (no carving split) | The API split relay fails at its spend step (commit lands, spend 502s, reason only in the unlogged response body); carve again once that's fixed. Open orders reserve whole notes. |
| Devnet's mock decryptor is accepted (`allowMockTee`) | Same as the dapp's `NEXT_PUBLIC_ALLOW_MOCK_TEE`; the key is protected in transit only, so docs say the operator could read prices. |
| Circuit cache `~/.siphon-mcp/zk` (`SIPHON_ZK_CACHE_DIR`, read by the SDK's `Prover`) | withdraw6's zkey is ~144 MB. |
| Mutating tools run one at a time (`exclusive`) | Two spends must never pick the same note. |

## Tools

| Tool | What it does |
|---|---|
| `siphon_wallet` | Address and public balances |
| `siphon_private_balance` | Private balance: spendable, waiting for ASP admission, reserved by orders |
| `siphon_market` | SOL/USD price and vault status |
| `siphon_deposit` | Private deposit |
| `siphon_send` | Relayed private payout |
| `siphon_swap` | Instant private swap: an `execute_now` order with bounds that are already true |
| `siphon_place_order` | Resting order. `at_or_above` → LIMIT_SELL with the upper bound; `at_or_below` → LIMIT_BUY with the lower bound |
| `siphon_orders` | Order status; claims return notes |
| `siphon_cancel_order` | Cancels an order that hasn't fired |

Prompts: `start`, `first-private-payment`, `encrypted-limit-order`.

## Build, test, publish

```sh
cd packages/mcp
bun install
bun run build                  # → dist/mcp/index.js + vendor/ (FHE wasm); the SDK is bundled in
npx tsc -p tsconfig.json       # typecheck, including the SDK sources it bundles
SIPHON_HOME=/tmp/siphon-test node test/smoke.mjs              # lists 9 tools + 3 prompts, calls siphon_wallet
SIPHON_HOME=/tmp/siphon-test node test/call.mjs siphon_deposit '{"asset":"SOL","amount":"0.05"}'
npm publish                    # unscoped; published by the npm account 0xswarn (the @siphon scope belongs to someone else)
```

Layout constraint: the SDK loads its FHE WebAssembly from `../../vendor/fhe-wasm/` relative to its own file. That's why the bundle lives at `dist/mcp/index.js` and `vendor/` sits at the package root.

## Live record (2026-10-12)

| Step | Result |
|---|---|
| Deposit, 0.05 SOL | 2.7 s; admitted within about 1 minute |
| Private payout, 0.01 SOL to a fresh address | 11.1 s including the first proof; the recipient got 0.01 WSOL and the 0.04 SOL change was spendable |
| Gateway FHE server-key cap | Fixed in siphon-fhe a424dc1 and deployed; FHE key setup works |
| Swap 0.01 SOL | Placed; the executor answered `NO_ROUTE` (Devnet pool's USDC side is drained, 5 USDC left at a $141 pool price) and the MCP released the notes |
| Resting order: place → armed → cancel → aborted | Works; the note is released |
| An order filling and its return note being claimed | Not yet seen live: it needs USDC liquidity in the Devnet pool |

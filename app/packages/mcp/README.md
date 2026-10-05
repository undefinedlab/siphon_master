# siphon-mcp

The [Siphon](https://siphon.money) MCP server. It gives Claude Code, Codex and any other MCP client a private vault on **Solana Devnet**:
- private deposits;
- relayed private payouts;
- instant private SOL↔USDC swaps;
- limit and stop orders whose trigger price is FHE-encrypted.

Everything secret stays on your machine: the note secrets that spend your balance, the FHE key, and order prices. Zero-knowledge proofs are generated locally too. The server only ever uses Devnet test tokens.

## Install

### Claude Code

```sh
claude mcp add siphon --scope user -- npx -y siphon-mcp
```

Start `claude` and run `/mcp` to check that `siphon` is connected. The starter prompts are built in as slash commands: `/mcp__siphon__start`, `/mcp__siphon__first-private-payment` and `/mcp__siphon__encrypted-limit-order`.

### Codex

```sh
codex mcp add siphon -- npx -y siphon-mcp
```

Codex gives a server 10 seconds to start and a tool 60 seconds to answer. A first `npx` install and a first private payment (which downloads the proving circuits once) need longer. Add `startup_timeout_sec = 60` and `tool_timeout_sec = 300` to the `[mcp_servers.siphon]` table that `codex mcp add` wrote to `~/.codex/config.toml`. Or skip `codex mcp add` and paste the whole entry yourself:

```toml
[mcp_servers.siphon]
command = "npx"
args = ["-y", "siphon-mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 300
```

Run `/mcp` inside `codex` to check that `siphon` is active.

### Any other MCP client (Claude Desktop, Cursor, …)

```json
{
  "mcpServers": {
    "siphon": { "command": "npx", "args": ["-y", "siphon-mcp"] }
  }
}
```

Requires Node.js 20 or newer.

## First run

You don't need any keys to start:

1. **Wallet:** the server creates a dedicated Devnet wallet at `~/.siphon-mcp/devnet-wallet.json`. It never uses `~/.config/solana/id.json`, which may be a real wallet.
2. **API key:** on first use it claims a free Siphon Devnet API key for that wallet and opens a Siphon account.
3. **Funding:** ask your agent for the wallet (`siphon_wallet`), then fund that address. Get SOL at [faucet.solana.com](https://faucet.solana.com), and Devnet USDC at [faucet.circle.com](https://faucet.circle.com) (choose Solana Devnet).

**Back up `~/.siphon-mcp`.** It holds the note secrets, and they are the only way to spend your private balance.

## Tools

| Tool | What it does |
|---|---|
| `siphon_wallet` | The Devnet wallet's address, its public SOL/USDC balances, and where the state lives |
| `siphon_private_balance` | Private balance per asset: spendable, waiting for compliance admission (~5 min after a deposit), and reserved by orders |
| `siphon_market` | SOL/USD price and the Devnet vault's status |
| `siphon_deposit` | Deposit SOL or USDC into the vault. Secrets are saved before anything is sent |
| `siphon_send` | Private payout to any Solana address, proven locally and relayed |
| `siphon_swap` | Instant private SOL↔USDC swap. The output comes back to the vault as a new private note |
| `siphon_place_order` | Resting order with an encrypted trigger. `at_or_above` covers limit sells and take-profits; `at_or_below` covers limit buys and stop-losses |
| `siphon_orders` | Order status. Claims filled outputs and frees notes from orders that ended unfilled |
| `siphon_cancel_order` | Cancel an order that hasn't fired yet |

## Prompts to start with

- "Show my Siphon Devnet wallet and private balance, and tell me how to fund the wallet."
- "Deposit 0.05 SOL privately into Siphon, wait until it is spendable, then pay 0.02 SOL privately to a brand-new address and show me the explorer link."
- "Swap 0.02 SOL to USDC privately with Siphon and tell me when the USDC is back in my private balance."
- "Get the SOL price, then place a private Siphon order selling 0.02 SOL if SOL rises 5% above it, expiring in 24 hours."
- "List my Siphon orders, claim anything that filled, and cancel the ones still waiting."

## Configuration

All settings are optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `SIPHON_SOLANA_KEYPAIR` | `~/.siphon-mcp/devnet-wallet.json` | Path to a Solana keypair file to sign with, in `solana-keygen` JSON format |
| `SIPHON_API_KEY` | claimed on first use | A Devnet key (`sk_…`) tied to that same wallet |
| `SIPHON_HOME` | `~/.siphon-mcp` | Where the notes, key and proving-circuit cache are stored |
| `SIPHON_API_URL` | `https://api-gateway-production-41e4.up.railway.app` | Railway Devnet API gateway |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Devnet RPC endpoint. Use your own if the public one rate-limits you |

## How privacy works here

- **Deposits are public.** The deposit transaction shows your wallet putting tokens into the vault.
- **Payouts are relayed.** The recipient's transaction comes from Siphon's relayer, and the zero-knowledge proof spends your notes without saying which deposit they came from.
- **Order triggers are encrypted.** They're encrypted on this machine, so the executor checks "is the price past X?" without learning X. One caveat for Devnet: the decryptor that reads the result isn't running in an attested TEE yet, so its operator could read your trigger prices.

These steps preserve that privacy:
- Pay out to a fresh address.
- Use round amounts.
- Leave some time between depositing and paying out.

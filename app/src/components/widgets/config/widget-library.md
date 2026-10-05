# Build dashboard — widget library

Canonical machine-readable spec: [`widget-library.json`](./widget-library.json).

Desktop grid is **6 columns × 3 rows** per page. Sizes use **W×H** = column-span × row-span.

## Starter glance widgets (fixed sizing for now)

These ship on the default board as compact **1×1** tiles. They may only use **1×1**, **1×2**, or **2×2** — no 2×1, 4×2, or full-width sizes. **Resize cycling is disabled** until glance layouts are finalized.

| Kind | Label | Default | Allowed sizes | Notes |
|------|--------|---------|---------------|--------|
| `fear-greed` | Fear & Greed | 1×1 | 1×1, 1×2, 2×2 | Sentiment gauge (alternative.me) |
| `market-cap` | Market cap | 1×1 | 1×1, 1×2, 2×2 | Global crypto market cap |
| `market-volume` | 24h volume | 1×1 | 1×1, 1×2, 2×2 | Aggregate 24h volume |

## Glance & core widgets

| Kind | Label | Default | Allowed sizes | Resizable |
|------|--------|---------|---------------|-----------|
| `news` | News | 2×1 | 2×1, 2×2, 4×2 | yes |
| `swap` | Swap | 2×2 | 2×2, 4×2 | yes |
| `coins` | Coins | 2×2 | 2×2, 4×2, 6×2 | yes |
| `opportunities` | Strategies | 2×2 | 2×2, 4×2, 6×2 | yes |
| `wallet` | Wallet | 2×2 | 2×2, 4×2 | yes |

## Optional add-ons

| Kind | Label | Default | Allowed sizes | Resizable |
|------|--------|---------|---------------|-----------|
| `stocks` | Stocks | 2×2 | 2×2, 4×2 | yes |
| `learn` | Learn | 2×2 | 2×2, 4×2 | yes (placeholder) |

## Default layout (page 1)

1. **Swap** — 2×2 (top-left)
2. **Fear & Greed** — 1×1
3. **Market cap** — 1×1
4. **24h volume** — 1×1
5. **News** — 2×1
6. **Coins** — 2×2 (`#movers`)
7. **Strategies** — 2×2 (`#strategies`)
8. **Wallet** — 2×2 (`#wallet`)

Extra widgets pack onto page 2+ via the paginator.

## Legacy

- `market-size` (combined cap + volume) was split into `market-cap` and `market-volume`. Old saved layouts migrate automatically.

# Level-2 Strategies & Control Blocks

How strategy kinds, control blocks (Schedule, Loop), and execution payloads fit together on the canvas.

See also: [README](./README.md) for block collaboration rules.

## Design principles

1. **Strategy block** — price/time-sliced triggers (Limit, Stop, Take Profit, Range, TWAP).
2. **Control blocks** — Schedule (start delay) and Loop (repeat body on cadence).
3. **No DCA strategy kind in the UI** — recurring buys use **Loop** + Swap (+ Withdraw), not `Strategy(DCA)`.
4. **Three layers** — canvas graph → `strategySpec` fields → execution payload (single-shot vs scheduled).

## Runtime tiers

| Tier | Blocks / kinds | Behavior |
|------|----------------|----------|
| `single_shot` | Limit Order, Stop Loss, Take Profit | One price trigger → one execution (ZK + payload API). |
| `scheduled` | Range, TWAP, Loop cadence | Multiple legs over time (trade-executor scheduler). |
| `recurring` | Loop (`until_funds` or `count`) | Repeats inner graph every `loopIntervalValue` + unit. |

**Active in Build toolbar today**

| Category | Items |
|----------|--------|
| Triggers | Limit Order, Stop Loss, Take Profit |
| Control | Schedule, Loop |
| DeFi | Deposit, Swap, Withdraw |

Range and TWAP exist in `strategySpec` and node UI when a Strategy block is added programmatically or from Discover templates; they are not in the default Triggers submenu yet.

## Strategy kinds (Strategy block)

### Limit Order
- **Fields:** `side`, `priceGoal`
- **Graph:** `Deposit → Strategy → Swap → Withdraw`

### Stop Loss / Take Profit
- **Fields:** `priceGoal`, optional `positionPct`
- **Graph:** `Deposit → Strategy → Swap → Withdraw`

### Range (grid)
- **Fields:** `rangeLow`, `rangeHigh`, `gridLevels`
- **Payload:** `RANGE_GRID` with grid legs
- **Runtime:** scheduled

### TWAP
- **Fields:** `sliceCount`, `intervalSeconds`, `maxSlippageBps`
- **Payload:** `TWAP` with `slices`, `interval_sec`
- **Runtime:** scheduled

## Control blocks (not Strategy kinds)

### Schedule
- **Fields:** `scheduleTrigger`, `scheduleValue`, `scheduleUnit`, `scheduleAt`
- **Graph:** Inserts after Deposit: `Deposit → Schedule → …`

### Loop (repeat group)
- **Fields:** `repeatMode`, `repeatCount`, `loopIntervalValue`, `loopIntervalUnit`
- **Body:** Swap, Strategy, Withdraw (children with `parentId`)
- **Graph:** `Deposit → Loop` with swap/withdraw inside
- **Replaces legacy DCA:** “DCA every 24h” = Loop `until_funds` + interval, not a Strategy block

## Withdraw amount semantics

- **Linked to Swap:** empty amount = withdraw **all swap output**; any typed value = fixed amount.
- **Coin:** should match swap `toCoin` when linked.

## Payload mapping

`buildStrategyPayload(kind, fields)` in `src/lib/strategySpec.ts` — see source for `strategy_type`, bounds, slices, intervals.

Loop-only flows without a Strategy node use scheduler metadata from the Loop block (`interval_sec`, `slices` when `count` mode).

## Builder agent Q&A

One question at a time for the first missing field (`src/builder_agent/questions.ts`).

| User intent | Built graph | Typical questions |
|-------------|-------------|-------------------|
| Limit / stop / tp | Deposit → Strategy → Swap → [Withdraw] | token → amount → price → [to coin] → wallet |
| Range | Deposit → Strategy(range) → Swap | token → amount → low → high → grid levels |
| TWAP | Deposit → Strategy(twap) → Swap | token → amount → slices → interval sec |
| DCA / recurring / every N | Deposit → Loop(swap → withdraw) | token → amount → loop cadence → [to coin] → wallet |
| + schedule | … with Schedule after Deposit | start delay if not in prompt |

**Keyword files:** `STRATEGY_KEYWORDS`, `RECURRING_FLOW_PATTERNS` in `src/builder_agent/blocks.ts`.

## Legacy aliases (parse only)

| Legacy | Maps to |
|--------|---------|
| Buy Dip | Limit buy |
| Sell Rally | Take profit |
| DCA (prompt) | **Loop flow** (not Strategy block) |

## Smoke validation

`runStrategySimulation()` walks the graph in execution order, tracks a **balance ledger** (with price conversion for swaps), and reports coin/balance errors before wallet checks.

## File map

| File | Role |
|------|------|
| `src/lib/strategySpec.ts` | Types, validation, payloads |
| `src/lib/strategySimulation.ts` | Smoke / balance ledger |
| `src/lib/repeatGraph.ts` | Loop container helpers |
| `src/lib/graphLinks.ts` | Swap→withdraw linking |
| `src/builder_agent/` | Prompt parse, flow create, Q&A |
| `src/components/navs/Builder/BuildNodes.tsx` | Per-block fields |
| `src/components/navs/Builder/RepeatGroupNode.tsx` | Loop UI |

# Siphon Builder: Strategies & Building Blocks

This document defines how strategy prompts map into visual blocks on the Build page, and how blocks collaborate to produce an executable flow.

## Goal

The Builder lets a user describe intent in plain language, then have the assistant:

1. infer the strategy structure,
2. create the right blocks,
3. connect them in valid order,
4. prefill fields with sensible defaults,
5. keep the graph logically executable.

Use **Smoke** (toolbar) to run a sequential validation pass over the canvas without live execution.

## Core Building Blocks

### 1) Deposit
- **Purpose:** Fund the strategy wallet.
- **Fields:** `chain`, `coin`, `amount`
- **Output:** Provides input asset + amount to downstream blocks.

### 2) Strategy (trigger)
- **Purpose:** Price or schedule-based execution trigger (single-shot or scheduled kinds).
- **Kinds in Build UI:** Limit Order, Stop Loss, Take Profit, Range, TWAP
- **Fields (per kind):**
  - Limit / Stop / Take Profit: `priceGoal`, optional `positionPct` (stop/tp)
  - Range: `rangeLow`, `rangeHigh`, `gridLevels`
  - TWAP: `sliceCount`, `intervalSeconds`, `maxSlippageBps`
- **Note:** There is **no DCA Strategy block**. Recurring buys use **Loop** instead (see below).

### 3) Schedule (control)
- **Purpose:** Delay the start of downstream execution.
- **Fields:** `scheduleTrigger` (`after` | `at`), `scheduleValue`, `scheduleUnit`, or `scheduleAt`
- **Typical use:** `Deposit → Schedule → Loop` or `Deposit → Schedule → Strategy`

### 4) Loop (repeat group)
- **Purpose:** Repeat inner blocks on a cadence until funds end or N times.
- **Fields:** `repeatMode` (`until_funds` | `count`), `repeatCount`, `loopIntervalValue`, `loopIntervalUnit`
- **Children:** Swap, Strategy, Withdraw (added inside the loop container)
- **Typical use:** DCA-style flows — `Deposit → Loop(Swap → Withdraw)` every 24 hours

### 5) Swap
- **Purpose:** Convert one asset into another.
- **Fields:** `dex`, `coin`, `amount`, `toCoin`, `toAmount` (estimated)
- **Output:** Transformed asset for withdrawal or next leg.

### 6) Withdraw
- **Purpose:** Send assets to an external wallet.
- **Fields:** `chain`, `coin`, `amount` (empty = all swap output when linked), `wallet`
- **Linking:** When connected after Swap, `amountSource` follows swap output automatically.

## Collaboration Rules

**Single-shot price trigger:**
`Deposit → Strategy → Swap → Withdraw`

**Recurring / DCA-style (no DCA block):**
`Deposit → [Schedule] → Loop → (Swap → Withdraw inside loop)`

**Schedule + limit:**
`Deposit → Schedule → Strategy → Swap → Withdraw`

Validation:
- At least one **Deposit** is required.
- A terminal action (**Swap** or **Withdraw**) is required.
- **Withdraw.wallet** required for executable flows.
- Asset continuity: `Deposit.coin` feeds `Swap.coin`; `Swap.toCoin` feeds `Withdraw.coin` when linked.

## Prompt-to-Graph Mapping

1. **Intent parse** — deposit, swap, withdraw, limit/stop/tp, range, twap, **loop/dca/recurring**, schedule.
2. **Block planning** — recurring prompts build **Loop**, not Strategy(DCA).
3. **Field prefill** — extracted values first; safe defaults for the rest.
4. **Edge synthesis** — canonical order; swap→withdraw links set output amount.
5. **Smoke test** — inline canvas validation with balance ledger.

## Strategy Profiles

See **[strategies_l2.md](./strategies_l2.md)** for payload mapping and runtime tiers.

| Profile | Graph pattern |
|---------|----------------|
| Limit Order | Deposit → Strategy → Swap → Withdraw |
| Stop Loss / Take Profit | Deposit → Strategy → Swap → Withdraw |
| Range (grid) | Deposit → Strategy(range) → Swap |
| TWAP | Deposit → Strategy(twap) → Swap → Withdraw |
| Recurring / DCA | Deposit → Loop(swap → withdraw) — optional Schedule |

## Builder Assistant

The chat assistant (`src/builder_agent/`) understands all block types above.

- **DCA / dollar-cost / every N hours** → builds **Loop** flow, asks for loop cadence if missing.
- **Limit / stop / take profit** → Strategy block + price fields.
- **Range / grid** → Strategy(range) + bounds + levels.
- **TWAP** → Strategy(twap) + slices + interval.
- **Withdraw** → wallet address; empty amount on linked withdraw = full swap output.

Keyword detection: `src/builder_agent/blocks.ts` (`STRATEGY_KEYWORDS`, `RECURRING_FLOW_PATTERNS`).

## UX Notes

- AI prompt bar: bottom-center; Enter submits.
- **Smoke** button: sequential step highlight + toast (no on-chain execution).
- **Run** button: opens Pay & Run with values ported from canvas blocks.

## File Map

| Area | Path |
|------|------|
| Canvas nodes | `src/components/navs/Builder/BuildNodes.tsx` |
| Loop container | `src/components/navs/Builder/RepeatGroupNode.tsx` |
| Strategy spec | `src/lib/strategySpec.ts` |
| Smoke engine | `src/lib/strategySimulation.ts` |
| Builder agent | `src/builder_agent/` |

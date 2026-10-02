"""Siphon fee model — central, env-overridable parameters.

Mirrors the published pricing sheet (v1.0, August 2026). Three charges, quoted in full before a
strategy is armed:

  Arming    $0.25 per strategy. Upfront, non-refundable, one per strategy regardless of leg count.
  Window    Priced ONCE at arming from the requested execution window — the maximum time the
            strategy stays armed and eligible to fill (1h $0.25 / 24h $0.50 / 7d $2.00 / 30d
            $5.00). Non-refundable: a window is an option on execution time, not metered usage,
            so an early fill is a good outcome rather than an overpayment.
  Fill      A flat percentage of the notional executed, deducted from the trade in the input
            asset: 0.20% retail, 0.05% API. No floor, no minimum, no per-leg charge — a 20-leg
            TWAP costs the same as one swap of equal size.

Withdrawal is NOT priced here. Exiting the vault costs network gas only and is charged on-chain
by Vault/WithdrawFee.sol (feeBps = 0, FLAT gas leg) — see scripts/setWithdrawFee.ts.

Arming + window are collected as ONE USDC transfer to the executor wallet before the strategy is
accepted. Fills stay in the executor wallet. Every charge is recorded as a FeeAccrual row; moving
the balances later is a normal treasury-wallet operation, not part of strategy creation.
"""
import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _i(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _b(name: str, default: bool) -> bool:
    return str(os.environ.get(name, str(default))).strip().lower() in ("1", "true", "yes", "on")


# Mandatory by default. Tests/emergency maintenance may explicitly set FEE_ENABLED=0.
FEE_ENABLED = _b("FEE_ENABLED", True)

# ── Arming ───────────────────────────────────────────────────────────────────
ARMING_USDC = _f("FEE_ARMING_USDC", 0.25)

# ── Window ───────────────────────────────────────────────────────────────────
# (max_hours, usd) ordered ascending; the first tier that covers the requested window wins, and
# anything longer than the last tier pays the last tier. Identical on both surfaces —
# confidential evaluation costs the same whoever asks for it.
WINDOW_TIERS_USD: list[tuple[float, float]] = [
    (1,    _f("FEE_WINDOW_1H_USD",  0.25)),
    (24,   _f("FEE_WINDOW_24H_USD", 0.50)),
    (168,  _f("FEE_WINDOW_7D_USD",  2.00)),
    (720,  _f("FEE_WINDOW_30D_USD", 5.00)),
]

# Cutover flag. OFF means the arming transfer is the bare ARMING_USDC, exactly as before, so this
# code can land without the browser and the executor having to deploy in the same breath. Turn it
# on only once a frontend that sends arming+window is live; the transfer check accepts an
# overpayment, so the two deploys are safe in either order.
# ponytail: a single flag beats a version-negotiation handshake for a one-time cutover.
WINDOW_FEE_ENABLED = _b("FEE_WINDOW_ENABLED", False)

# ── Fill ─────────────────────────────────────────────────────────────────────
EXEC_BPS = _f("FEE_EXEC_BPS", 20)          # 0.20% of notional — retail (siphon.money)
EXEC_BPS_API = _f("FEE_EXEC_BPS_API", 5)   # 0.05% of notional — partners via the API gateway

# ── Limits ───────────────────────────────────────────────────────────────────
MAX_LEGS = _i("FEE_MAX_LEGS", 50)          # leg cap per strategy (pricing sheet, Definitions)

# Stablecoins are treated as $1 for USD<->asset conversion.
STABLE_SYMBOLS = {"USDC", "USDT", "DAI"}

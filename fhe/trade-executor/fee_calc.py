"""Pure fee math for the Siphon pricing sheet. No I/O — easy to unit-test.

The fill fee is taken in the INPUT asset (the executor holds the withdrawn amount_wei in asset_in
before swapping). `asset_usd_price` is the USD price of asset_in (the scheduler's current_price ==
PYTH price of asset_in; stablecoins ~= $1).
"""
import fee_config as fc


def window_fee_usd(window_hours: float) -> float:
    """Price the execution window: the first tier that covers it, last tier for anything longer.

    A missing or zero window means the shortest tier — every arm path in the app sends a window,
    and its own parser falls back to 1 hour, so this keeps the two ends agreeing.
    """
    if not fc.FEE_ENABLED or not fc.WINDOW_FEE_ENABLED:
        return 0.0
    hours = max(0.0, float(window_hours or 0))
    for max_hours, usd in fc.WINDOW_TIERS_USD:
        if hours <= max_hours:
            return usd
    return fc.WINDOW_TIERS_USD[-1][1]


def compute_arming_fee_usd(window_hours: float = 0.0) -> float:
    """What the user transfers before a strategy is accepted: arming + the window it asked for.

    Charged once per strategy no matter how many legs it carries.
    """
    if not fc.FEE_ENABLED:
        return 0.0
    return fc.ARMING_USDC + window_fee_usd(window_hours)


def exec_bps(is_api: bool = False) -> float:
    """Fill rate for the surface the order came from. API orders are identified by the signed
    billing_ref the gateway attaches; anything without one is retail."""
    return fc.EXEC_BPS_API if is_api else fc.EXEC_BPS


def compute_execution_fee_wei(amount_wei: int, decimals: int, asset_usd_price: float,
                              days_armed: float = 0.0, is_api: bool = False) -> int:
    """The fill fee: a flat percentage of the notional executed, in input-asset wei.

    No floor and no gas add-on — the window fee, charged once at arming, is what prices the time
    an order spends armed, so `days_armed` is accepted and ignored (callers still pass it).
    Never exceeds 50% of the trade (safety clamp against a bad rate).
    """
    if not fc.FEE_ENABLED or amount_wei <= 0:
        return 0

    # A direct fraction of the input amount — no USD round-trip, so a missing price cannot skew it.
    fee_wei = int(amount_wei * exec_bps(is_api)) // 10000
    return min(fee_wei, amount_wei // 2)


def usd_to_wei(usd: float, decimals: int, asset_usd_price: float) -> int:
    """Convert a USD amount to asset base units."""
    if not usd or not asset_usd_price or asset_usd_price <= 0:
        return 0
    return int(usd / asset_usd_price * (10 ** decimals))


if __name__ == "__main__":
    # ponytail self-check: the worked examples straight off the pricing sheet.
    import fee_config as _fc
    _fc.FEE_ENABLED = True
    _fc.WINDOW_FEE_ENABLED = True
    S = 10 ** 6  # USDC decimals, $1/unit

    # Window tiers, including the boundaries and the over-30d clamp.
    assert window_fee_usd(0) == 0.25 and window_fee_usd(1) == 0.25
    assert window_fee_usd(2) == 0.50 and window_fee_usd(24) == 0.50
    assert window_fee_usd(25) == 2.00 and window_fee_usd(168) == 2.00
    assert window_fee_usd(169) == 5.00 and window_fee_usd(720) == 5.00
    assert window_fee_usd(10_000) == 5.00, "anything past the last tier pays the last tier"

    # Retail: $250 limit order, 24h -> arming 0.25 + window 0.50 + fill 0.50 = $1.25 (50 bps).
    arm = compute_arming_fee_usd(24)
    fill = compute_execution_fee_wei(250 * S, 6, 1.0) / S
    assert abs(arm - 0.75) < 1e-9, arm
    assert abs(fill - 0.50) < 1e-9, fill
    assert abs(arm + fill - 1.25) < 1e-9

    # Retail: $10,000 limit order, 7d -> 0.25 + 2.00 + 20.00 = $22.25 (22 bps).
    assert abs(compute_arming_fee_usd(168) + compute_execution_fee_wei(10_000 * S, 6, 1.0) / S
               - 22.25) < 1e-6

    # API: same $10,000 / 7d at 5 bps -> 0.25 + 2.00 + 5.00 = $7.25 (7 bps).
    assert abs(compute_execution_fee_wei(10_000 * S, 6, 1.0, is_api=True) / S - 5.00) < 1e-6
    assert abs(compute_arming_fee_usd(168)
               + compute_execution_fee_wei(10_000 * S, 6, 1.0, is_api=True) / S - 7.25) < 1e-6

    # No floor and no per-leg minimum: a tiny fill pays only its percentage.
    assert compute_execution_fee_wei(1 * S, 6, 1.0) == 2000, "0.20% of $1 is $0.002, not a floor"
    # days_armed is priced by the window at arming, so it must not move the fill.
    assert compute_execution_fee_wei(1000 * S, 6, 1.0, days_armed=99) == \
           compute_execution_fee_wei(1000 * S, 6, 1.0)
    # 50% clamp still holds.
    assert compute_execution_fee_wei(100, 6, 1.0) <= 50

    # Cutover flag off -> the arming transfer is the bare $0.25, exactly as before.
    _fc.WINDOW_FEE_ENABLED = False
    assert window_fee_usd(720) == 0.0
    assert compute_arming_fee_usd(720) == 0.25

    # Fees off -> everything is zero.
    _fc.FEE_ENABLED = False
    assert compute_arming_fee_usd(24) == 0.0
    assert compute_execution_fee_wei(1000 * S, 6, 1.0) == 0

    print("fee_calc self-check OK — sheet examples reproduce: $250/24h=$1.25, "
          "$10k/7d retail=$22.25, $10k/7d api=$7.25")

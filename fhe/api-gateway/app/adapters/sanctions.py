"""Sanctions screening — a thin wrapper over the reused executor Chainalysis oracle check.

The executor's check_sanctions itself fails OPEN on an RPC error; the gateway's WRITE path enforces
fail-CLOSED at the service layer (a screening failure blocks a fund-moving call). This adapter just
exposes the reused primitive; the fail-closed policy lives where the call is made (deposit/withdraw/
consolidation services), so reads stay unaffected.
"""
from app.reuse import check_sanctions


class SanctionsClient:
    def screen(self, address: str, chain_id: int | str) -> tuple[bool, str]:
        """Return (is_sanctioned, reason). Raises nothing — a raised RPC error inside check_sanctions
        is caught there and returns (False, "") (fail-open); the write-path service turns an inability
        to screen into a fail-closed block, not this adapter."""
        return check_sanctions(address, str(chain_id))

from app.reuse import check_sanctions
from address_validator import _ORACLE_RPC
from app.errors import Sanctioned
import httpx


def screen_address(address: str, chain_id: int | str) -> None:
    """Screen an address against the Chainalysis sanctions oracle.
    
    Fail-closed: raises Sanctioned (451) if the address is sanctioned,
    or if the RPC connection/ping fails. EVM mainnets only.
    """
    cid = str(chain_id)
    if cid not in _ORACLE_RPC:
        return

    rpc_url = _ORACLE_RPC[cid]
    if not rpc_url:
        raise Sanctioned("Sanctions RPC not configured.")

    # Fail-closed check: verify the RPC is reachable first
    try:
        with httpx.Client(timeout=4.0) as client:
            resp = client.post(
                rpc_url,
                json={"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}
            )
            if resp.status_code != 200:
                raise Exception(f"RPC returned non-200 status code: {resp.status_code}")
    except Exception as e:
        raise Sanctioned(f"Sanctions screening could not complete: RPC unreachable ({e})")

    is_sanctioned, reason = check_sanctions(address, cid)
    if is_sanctioned:
        raise Sanctioned(reason or "Address is sanctioned.")

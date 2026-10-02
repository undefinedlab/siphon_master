from web3 import Web3
from app.config import get_settings
from app.errors import Conflict, DownstreamUnavailable
from web3.exceptions import TransactionNotFound


def validate_submitted_transaction(
    chain_id: int, tx_hash: str, *, expected_to: str, expected_data_sha256: str
) -> None:
    """Bind an operation to the exact on-chain transaction plan it returned to the client."""
    from app.services.unsigned_transaction_service import transaction_data_sha256

    rpc_url = get_rpc_url(chain_id)
    if not rpc_url:
        raise Conflict("Unsupported transaction chain.")
    try:
        tx = Web3(Web3.HTTPProvider(rpc_url)).eth.get_transaction(tx_hash)
    except Exception:
        raise Conflict("Transaction is not yet visible on the configured RPC.")
    actual_to = tx.get("to") if hasattr(tx, "get") else None
    actual_data = tx.get("input") if hasattr(tx, "get") else None
    if isinstance(actual_data, bytes):
        actual_data = "0x" + actual_data.hex()
    elif hasattr(actual_data, "hex"):
        actual_data = actual_data.hex()
    if not actual_to or str(actual_to).lower() != expected_to.lower():
        raise Conflict("Transaction target does not match the authorized operation.")
    if transaction_data_sha256(str(actual_data or "")) != expected_data_sha256:
        raise Conflict("Transaction calldata does not match the authorized operation.")


def get_rpc_url(chain_id: int) -> str | None:
    settings = get_settings()
    return {
        8453: settings.base_mainnet_rpc,
        42161: settings.arbitrum_rpc,
        11155111: settings.eth_sepolia_rpc,
    }.get(chain_id) or None


def find_tx_chain_and_receipt(tx_hash: str) -> tuple[int, dict] | None:
    """Scan supported chains to locate the transaction receipt."""
    for chain_id in (8453, 42161, 11155111):
        rpc_url = get_rpc_url(chain_id)
        if not rpc_url:
            continue
        try:
            w3 = Web3(Web3.HTTPProvider(rpc_url))
            receipt = w3.eth.get_transaction_receipt(tx_hash)
            if receipt is not None:
                return chain_id, receipt
        except Exception:
            pass
    return None


def is_confirmed(chain_id: int, tx_hash: str) -> bool:
    """Has this transaction reached the required block confirmations?

    Returns False only when the chain gives a real negative — the tx is absent, reverted, or not
    yet deep enough. If the RPC itself cannot be reached, this RAISES DownstreamUnavailable rather
    than returning False.

    That distinction is the whole point. This used to swallow every exception into False, so an
    exhausted API key or a network blip was reported to the user as "Payment transaction is missing,
    failed, or not yet confirmed" — a sentence about THEIR money, for a problem entirely on our
    side, on a payment that was already on-chain and perfectly valid. It also made the failure
    look permanent when it was transient, which is what stops someone from simply retrying.
    An unreachable node means we do not know; saying so as a 503 is both true and retryable.
    """
    rpc_url = get_rpc_url(chain_id)
    if not rpc_url:
        raise DownstreamUnavailable(
            f"No RPC is configured for chain {chain_id}; cannot verify the payment."
        )

    try:
        w3 = Web3(Web3.HTTPProvider(rpc_url))
        receipt = w3.eth.get_transaction_receipt(tx_hash)
        current_block = w3.eth.block_number
    except TransactionNotFound:
        # A genuine negative: the chain answered and does not have it (yet).
        return False
    except Exception as exc:
        raise DownstreamUnavailable(
            "Could not reach the chain to verify your payment. The payment itself is unaffected — "
            "retry in a moment."
        ) from exc

    if not receipt or receipt.get("status") != 1:
        return False

    tx_block = receipt.get("blockNumber")
    if tx_block is None:
        return False

    required_confirmations = get_settings().confirmations.get(chain_id, 2)
    return (current_block - tx_block) >= required_confirmations

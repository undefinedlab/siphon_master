"""
Li.Fi cross-chain swap executor.
Docs: https://docs.li.fi/li.fi-api/li.fi-api
Quote API: GET https://li.quest/v1/quote
"""
import os
import threading
import time
from typing import Optional
import requests
from dotenv import load_dotenv

load_dotenv()

LIFI_API_BASE = "https://li.quest/v1"
LIFI_API_KEY = os.getenv("LIFI_API_KEY", "")
# Serialises approve→send against the LI.FI diamond across strategy legs (request threads) and
# bridge orders (scheduler): both set the executor's allowance for the same token and spender.
APPROVE_LOCK = threading.RLock()


def _web3():
    from web3 import Web3

    return Web3


def _inject_poa(w3) -> None:
    try:
        from web3.middleware import ExtraDataToPOAMiddleware

        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        return
    except Exception:
        pass
    try:
        from web3.middleware import geth_poa_middleware

        w3.middleware_onion.inject(geth_poa_middleware, layer=0)
    except Exception:
        pass


def _account_for_chain(w3, chain_id: int):
    # Routes through get_executor_account → RemoteAccount (CVM) in remote-signing mode, or a
    # local key otherwise. Bridge approve/send txs are then signed wherever the key lives.
    from evm_executor import get_executor_account
    return get_executor_account(w3, chain_id)


def get_lifi_quote(
    from_chain: str,
    to_chain: str,
    from_token: str,
    to_token: str,
    from_amount: int,
    from_address: str,
    to_address: str,
) -> dict:
    """Get best route quote from Li.Fi."""
    params = {
        "fromChain": from_chain,
        "toChain": to_chain,
        "fromToken": from_token,
        "toToken": to_token,
        "fromAmount": str(from_amount),
        "fromAddress": from_address,
        "toAddress": to_address,
    }
    headers = {"x-lifi-api-key": LIFI_API_KEY} if LIFI_API_KEY else {}
    resp = requests.get(f"{LIFI_API_BASE}/quote", params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def execute_lifi_swap(
    from_chain: str,
    to_chain: str,
    from_token: str,
    to_token: str,
    from_amount_wei: int,
    recipient: str,
    rpc_url: Optional[str] = None,
) -> str:
    """Execute a Li.Fi swap/bridge on the source chain. Returns tx hash."""
    if not rpc_url:
        from evm_chain_config import get_evm_chain_config
        rpc_url = get_evm_chain_config(from_chain).rpc_url

    Web3 = _web3()
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    _inject_poa(w3)

    account = _account_for_chain(w3, int(from_chain))

    print(f"[LiFi] Quoting {from_token}→{to_token} from chain {from_chain} to {to_chain}")
    t0 = time.monotonic()
    quote = get_lifi_quote(
        from_chain=from_chain,
        to_chain=to_chain,
        from_token=from_token,
        to_token=to_token,
        from_amount=from_amount_wei,
        from_address=account.address,
        to_address=recipient,
    )
    print(f"[Benchmark] lifi_quote                          = {(time.monotonic()-t0)*1000:>8.1f} ms")

    tx_req = quote.get("transactionRequest")
    if not tx_req:
        raise RuntimeError(f"Li.Fi returned no transactionRequest: {quote}")

    APPROVE_LOCK.acquire()
    try:
        return _approve_and_send(w3, account, quote, tx_req, from_token, from_amount_wei)
    finally:
        APPROVE_LOCK.release()


def _approve_and_send(w3, account, quote, tx_req, from_token, from_amount_wei) -> str:
    approval = quote.get("estimate", {}).get("approvalAddress")
    if approval and from_token.lower() not in (
        "0x0000000000000000000000000000000000000000",
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ):
        _approve_token(w3, account, from_token, approval, from_amount_wei)

    # 'pending' nonce: right after the approve's receipt, a lagging LB replica can still hold
    # that approve in its mempool view — 'latest' then reuses its nonce and the bridge tx dies
    # with "replacement transaction underpriced". 'pending' is correct on fresh AND lagging nodes.
    nonce = w3.eth.get_transaction_count(account.address, "pending")
    base_fee = w3.eth.get_block("latest")["baseFeePerGas"]
    priority = w3.to_wei(2, "gwei")

    tx = {
        "from": account.address,
        "to": tx_req["to"],
        "data": tx_req.get("data", "0x"),
        "value": int(tx_req.get("value", 0), 16) if isinstance(tx_req.get("value"), str) else int(tx_req.get("value", 0)),
        "gas": int(tx_req.get("gasLimit", 500_000), 16) if isinstance(tx_req.get("gasLimit"), str) else int(tx_req.get("gasLimit", 500_000)),
        "maxFeePerGas": base_fee * 2 + priority,
        "maxPriorityFeePerGas": priority,
        "nonce": nonce,
        "chainId": w3.eth.chain_id,
        "type": 2,
    }

    signed = account.sign_transaction(tx)
    t1 = time.monotonic()
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction).hex()
    print(f"[LiFi] Tx broadcast: {tx_hash}")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)
    print(f"[Benchmark] lifi_swap_total                     = {(time.monotonic()-t1)*1000:>8.1f} ms")
    if receipt.status != 1:
        raise RuntimeError(f"Li.Fi tx failed: {tx_hash}")
    return tx_hash


def get_lifi_status(tx_hash: str, from_chain=None, to_chain=None, bridge=None) -> dict:
    """LiFi transfer status for a source-chain tx. status ∈ NOT_FOUND|PENDING|DONE|FAILED|INVALID."""
    params = {"txHash": tx_hash}
    if from_chain:
        params["fromChain"] = str(from_chain)
    if to_chain:
        params["toChain"] = str(to_chain)
    if bridge:
        params["bridge"] = bridge
    headers = {"x-lifi-api-key": LIFI_API_KEY} if LIFI_API_KEY else {}
    resp = requests.get(f"{LIFI_API_BASE}/status", params=params, headers=headers, timeout=20)
    resp.raise_for_status()
    return resp.json()


def wait_for_lifi_completion(tx_hash: str, from_chain, to_chain, timeout: int = 600, poll: int = 5) -> dict:
    """Block until the destination-chain transfer completes. A bridge is ASYNC — the source tx
    confirming does NOT mean the funds arrived on the destination chain. Returns the final status
    dict (with `receiving` = {txHash, amount, ...}); raises on FAILED/INVALID or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status = get_lifi_status(tx_hash, from_chain, to_chain)
            st = (status.get("status") or "").upper()
            if st == "DONE":
                recv = status.get("receiving", {}) or {}
                print(f"[LiFi] bridge DONE → dest tx {recv.get('txHash')} amount {recv.get('amount')}")
                return status
            if st in ("FAILED", "INVALID"):
                raise RuntimeError(f"LiFi bridge {st}: {status.get('substatusMessage') or status.get('substatus') or status}")
            print(f"[LiFi] bridge {st or 'PENDING'}… ({int(deadline - time.monotonic())}s left)")
        except RuntimeError:
            raise
        except Exception as e:
            print(f"[LiFi] status poll error (retrying): {e}")
        time.sleep(poll)
    raise RuntimeError(f"LiFi bridge timed out after {timeout}s (src tx {tx_hash})")


def bridge_and_wait(
    from_chain: str,
    to_chain: str,
    from_token: str,
    to_token: str,
    from_amount_wei: int,
    recipient: str,
    rpc_url: Optional[str] = None,
    timeout: int = 600,
) -> dict:
    """Execute a LiFi bridge AND wait for the destination funds to land. Use this (not
    execute_lifi_swap alone) whenever a follow-up step spends the bridged funds on the destination
    chain. Returns {src_tx, dest_tx, received_wei}."""
    src_tx = execute_lifi_swap(from_chain, to_chain, from_token, to_token, from_amount_wei, recipient, rpc_url)
    status = wait_for_lifi_completion(src_tx, from_chain, to_chain, timeout=timeout)
    recv = status.get("receiving", {}) or {}
    received_wei = int(recv.get("amount") or 0)
    return {"src_tx": src_tx, "dest_tx": recv.get("txHash"), "received_wei": received_wei}


def _approve_token(w3, account, token_address, spender, amount):
    """Approve ERC20 spend for Li.Fi router. No-ops when the allowance already covers amount."""
    Web3 = _web3()
    erc20_abi = ('[{"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],'
                 '"name":"approve","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},'
                 '{"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],'
                 '"name":"allowance","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]')
    token = w3.eth.contract(address=Web3.to_checksum_address(token_address), abi=erc20_abi)
    if token.functions.allowance(account.address, Web3.to_checksum_address(spender)).call() >= amount:
        return
    nonce = w3.eth.get_transaction_count(account.address, "pending")
    base_fee = w3.eth.get_block("latest")["baseFeePerGas"]
    tx = token.functions.approve(spender, amount).build_transaction({
        "from": account.address,
        "nonce": nonce,
        "maxFeePerGas": base_fee * 2 + w3.to_wei(2, "gwei"),
        "maxPriorityFeePerGas": w3.to_wei(2, "gwei"),
        "type": 2,
    })
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction).hex()
    w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    print(f"[LiFi] Token approved: {tx_hash}")

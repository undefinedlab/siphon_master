"""Idempotent recovery for a private EVM strategy whose withdrawal confirmed.

The recovery resumes after the spent-nullifier boundary. It derives custody from the
withdrawal receipt's token Transfer event and the fee ledger; it never attributes the
executor's pooled wallet balance to a strategy.
"""

import argparse
import base64
import fcntl
import gzip
import json
import os
import requests
import sqlite3
import time
from dataclasses import asdict, dataclass, replace
from datetime import datetime
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import create_engine, text
from web3 import Web3
from web3.exceptions import TransactionNotFound
from transaction_policy import (
    NATIVE_VAULT_GAS_FLOOR,
    SWAP_GAS_FLOOR,
    fee_params,
    wait_for_sufficient_balance,
)


@dataclass(frozen=True)
class RecoveryAmounts:
    proof_amount: int
    receipt_payout: int
    vault_fee: int
    execution_fee: int
    swap_amount: int

    @classmethod
    def from_receipt(
        cls,
        *,
        proof_amount: int,
        receipt_payout: int,
        unswept_execution_fees: Iterable[int],
    ) -> "RecoveryAmounts":
        proof_amount = int(proof_amount)
        receipt_payout = int(receipt_payout)
        execution_fee = sum(int(value) for value in unswept_execution_fees)
        if proof_amount <= 0 or receipt_payout <= 0:
            raise ValueError("proof amount and receipt payout must be positive")
        if receipt_payout > proof_amount:
            raise ValueError("receipt payout exceeds the proof amount")
        swap_amount = receipt_payout - execution_fee
        if swap_amount <= 0:
            raise ValueError("no recoverable payout remains after execution fees")
        return cls(
            proof_amount=proof_amount,
            receipt_payout=receipt_payout,
            vault_fee=proof_amount - receipt_payout,
            execution_fee=execution_fee,
            swap_amount=swap_amount,
        )


@dataclass(frozen=True)
class RecoveryPlan:
    strategy_id: str
    chain_id: int
    executor: str
    withdraw_tx: str
    usdc: str
    weth: str
    router: str
    pool: str
    pool_fee: int
    output_precommitment: str
    slippage_bps: int
    eth_usd_price: float
    amount_out_minimum: int
    amounts: RecoveryAmounts

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["amounts"] = asdict(self.amounts)
        return payload


TRANSFER_TOPIC = Web3.keccak(text="Transfer(address,address,uint256)")


def _topic_address(topic) -> str:
    return Web3.to_checksum_address("0x" + bytes(topic)[-20:].hex())


def _load_strategy(database_path: str, strategy_id: str) -> tuple[dict, list[int]]:
    db = sqlite3.connect(database_path)
    db.row_factory = sqlite3.Row
    try:
        row = db.execute(
            """
            SELECT id, status, asset_in, asset_out, amount, from_chain, to_chain,
                   output_mode, output_precommitment, max_slippage_bps, tx_hash,
                   zkp_data
            FROM strategy WHERE id = ?
            """,
            (strategy_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"strategy {strategy_id} was not found")
        fee_rows = db.execute(
            """
            SELECT amount_wei FROM fee_accruals
            WHERE strategy_id = ? AND chain_id = ? AND asset = 'USDC'
              AND kind = 'execution'
            """,
            (strategy_id, int(row["from_chain"])),
        ).fetchall()
        strategy = dict(row)
        strategy["zkp_data"] = _decode_compressed_json(strategy.get("zkp_data"))
        return strategy, [int(value["amount_wei"]) for value in fee_rows]
    finally:
        db.close()


def _validate_strategy(strategy: dict) -> None:
    expected = {
        "status": "FAILED",
        "asset_in": "USDC",
        "asset_out": "ETH",
        "output_mode": "vault",
    }
    for field, value in expected.items():
        if strategy.get(field) != value:
            raise ValueError(
                f"strategy {field} must be {value!r}, got {strategy.get(field)!r}"
            )
    if str(strategy.get("from_chain")) != str(strategy.get("to_chain")):
        raise ValueError("recovery supports only same-chain strategies")
    if not strategy.get("output_precommitment"):
        raise ValueError("strategy has no output precommitment")
    if strategy.get("tx_hash"):
        raise ValueError("strategy already has a final transaction hash")


def _decode_compressed_json(raw) -> dict:
    if raw is None:
        raise ValueError("strategy has no stored ZK proof")
    if isinstance(raw, memoryview):
        raw = raw.tobytes()
    if isinstance(raw, bytes):
        raw = raw.decode()
    try:
        decoded = gzip.decompress(base64.b64decode(raw)).decode()
    except Exception:
        decoded = raw
    try:
        value = json.loads(decoded)
    except Exception as exc:
        raise ValueError("stored ZK proof is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("stored ZK proof must be an object")
    return value


def _proof_nullifiers(zkp_data: dict) -> list[int]:
    proof = zkp_data.get("proof") if isinstance(zkp_data.get("proof"), dict) else zkp_data
    values = proof.get("nullifierHashes")
    if values is None:
        singular = proof.get("nullifierHash")
        values = [singular] if singular is not None else []
    if not isinstance(values, list) or not values:
        raise ValueError("stored ZK proof has no nullifier hashes")
    return [int(value) for value in values]


def _validate_withdraw_call(
    call_args: dict,
    *,
    chain,
    executor: str,
    proof_amount: int,
    zkp_data: dict,
) -> None:
    if Web3.to_checksum_address(call_args["_asset"]) != Web3.to_checksum_address(chain.usdc):
        raise ValueError("withdrawal calldata asset does not match strategy USDC")
    if Web3.to_checksum_address(call_args["_recipient"]) != executor:
        raise ValueError("withdrawal calldata recipient does not match executor")
    if int(call_args["_withdrawnValue"]) != proof_amount:
        raise ValueError("withdrawal calldata amount does not match strategy")
    if [int(value) for value in call_args["_nullifierHashes"]] != _proof_nullifiers(zkp_data):
        raise ValueError("withdrawal calldata nullifiers do not match stored strategy proof")


def _receipt_payout(
    w3,
    chain,
    executor: str,
    withdraw_tx: str,
    *,
    proof_amount: int,
    zkp_data: dict,
) -> int:
    from evm_executor import ENTRYPOINT_ABI, ENTRYPOINT_VAULT_ABI

    receipt = w3.eth.get_transaction_receipt(withdraw_tx)
    if int(receipt.status) != 1:
        raise ValueError("withdrawal receipt is not successful")
    tx = w3.eth.get_transaction(withdraw_tx)
    if Web3.to_checksum_address(tx["from"]) != executor:
        raise ValueError("withdrawal transaction was not sent by the executor")
    if Web3.to_checksum_address(tx["to"]) != Web3.to_checksum_address(chain.entrypoint):
        raise ValueError("withdrawal transaction did not call the configured entrypoint")
    entrypoint_call = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint), abi=ENTRYPOINT_ABI
    )
    function, call_args = entrypoint_call.decode_function_input(tx["input"])
    if function.fn_name != "withdraw":
        raise ValueError("withdrawal transaction calldata is not Entrypoint.withdraw")
    _validate_withdraw_call(
        call_args,
        chain=chain,
        executor=executor,
        proof_amount=proof_amount,
        zkp_data=zkp_data,
    )

    entrypoint = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint),
        abi=ENTRYPOINT_VAULT_ABI,
    )
    vault = Web3.to_checksum_address(entrypoint.functions.getVault(chain.usdc).call())
    usdc = Web3.to_checksum_address(chain.usdc)
    payout = 0
    for log in receipt["logs"]:
        topics = log["topics"]
        if Web3.to_checksum_address(log["address"]) != usdc or len(topics) < 3:
            continue
        if bytes(topics[0]) != bytes(TRANSFER_TOPIC):
            continue
        if _topic_address(topics[1]) != vault or _topic_address(topics[2]) != executor:
            continue
        payout += int(bytes(log["data"]).hex() or "0", 16)
    if payout <= 0:
        raise ValueError("withdrawal receipt has no attributable USDC payout")
    return payout


def _find_output_deposit(indexer_db_uri: str, chain_id: int, precommitment: str) -> Optional[dict]:
    if not indexer_db_uri:
        raise ValueError("INDEXER_DB_URI is required for recovery idempotency")
    engine = create_engine(indexer_db_uri, pool_pre_ping=True)
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text(
                    """
                    SELECT amount, commitment, precommitment, block_number, tx_hash
                    FROM vault_deposit
                    WHERE chain_id = :chain_id AND precommitment = :precommitment
                    ORDER BY block_number DESC LIMIT 1
                    """
                ),
                {"chain_id": chain_id, "precommitment": precommitment},
            ).mappings().first()
        return dict(row) if row else None
    finally:
        engine.dispose()


def _fresh_pyth_price(feed_id: str, *, max_age_seconds: int = 60) -> float:
    base = os.environ.get("PYTH_HERMES_URL", "https://hermes.pyth.network").rstrip("/")
    response = requests.get(
        f"{base}/v2/updates/price/latest",
        params=[("ids[]", feed_id), ("parsed", "true")],
        timeout=10,
    )
    response.raise_for_status()
    parsed = response.json().get("parsed") or []
    if len(parsed) != 1:
        raise ValueError("Pyth returned no unique ETH/USD price")
    price_data = parsed[0].get("price") or {}
    publish_time = int(price_data.get("publish_time") or 0)
    age = int(time.time()) - publish_time
    if publish_time <= 0 or age < -10 or age > max_age_seconds:
        raise ValueError(f"Pyth ETH/USD price is stale (age={age}s)")
    price = int(price_data["price"]) * (10 ** int(price_data["expo"]))
    if price <= 0:
        raise ValueError("Pyth ETH/USD price is not positive")
    return float(price)


def build_recovery_plan(
    *,
    database_path: str,
    strategy_id: str,
    withdraw_tx: str,
    expected_executor: str,
) -> RecoveryPlan:
    from config import PYTH_PRICE_FEED_IDS
    from evm_chain_config import get_evm_chain_config
    from evm_executor import (
        _resolve_v3_pool,
        get_executor_account,
        get_web3,
        minimum_output_wei,
    )

    strategy, fees = _load_strategy(database_path, strategy_id)
    _validate_strategy(strategy)
    if len(fees) != 1:
        raise ValueError(
            f"strategy must have exactly one execution-fee record, found {len(fees)}"
        )
    chain_id = int(strategy["from_chain"])
    chain = get_evm_chain_config(chain_id)
    w3 = get_web3(chain)
    if not w3.is_connected() or int(w3.eth.chain_id) != chain_id:
        raise ValueError("configured RPC is unavailable or on the wrong chain")
    account = get_executor_account(w3, chain_id)
    executor = Web3.to_checksum_address(account.address)
    if executor != Web3.to_checksum_address(expected_executor):
        raise ValueError(f"executor mismatch: signer returned {executor}")

    proof_amount = int(Decimal(str(strategy["amount"])) * Decimal(10**6))
    payout = _receipt_payout(
        w3,
        chain,
        executor,
        withdraw_tx,
        proof_amount=proof_amount,
        zkp_data=strategy["zkp_data"],
    )
    amounts = RecoveryAmounts.from_receipt(
        proof_amount=proof_amount,
        receipt_payout=payout,
        unswept_execution_fees=fees,
    )
    pool, pool_fee = _resolve_v3_pool(
        w3, chain, chain.usdc, chain.weth, chain.swap_fee_tier
    )
    feed_id = PYTH_PRICE_FEED_IDS["ETH"]
    price = _fresh_pyth_price(feed_id)
    slippage_bps = int(strategy.get("max_slippage_bps") or 300)
    amount_out_minimum = minimum_output_wei(
        "USDC", "ETH", amounts.swap_amount, price, slippage_bps
    )
    return RecoveryPlan(
        strategy_id=strategy_id,
        chain_id=chain_id,
        executor=executor,
        withdraw_tx=Web3.to_hex(hexstr=withdraw_tx),
        usdc=Web3.to_checksum_address(chain.usdc),
        weth=Web3.to_checksum_address(chain.weth),
        router=Web3.to_checksum_address(chain.uniswap_v3_router),
        pool=pool,
        pool_fee=pool_fee,
        output_precommitment=str(strategy["output_precommitment"]),
        slippage_bps=slippage_bps,
        eth_usd_price=float(price),
        amount_out_minimum=amount_out_minimum,
        amounts=amounts,
    )


def _write_journal(path: str, payload: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    directory = os.path.dirname(path) or "."
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _load_journal(path: str) -> Optional[dict]:
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _plan_identity(plan: dict) -> dict:
    """Compare immutable custody facts while allowing a fresh oracle price on resume."""
    identity = dict(plan)
    for runtime_pricing_field in (
        "eth_usd_price",
        "amount_out_minimum",
        "oracle_amount_out_minimum",
        "forced_sepolia_pool_price",
        "pool_quote",
    ):
        identity.pop(runtime_pricing_field, None)
    return identity


def _pool_relative_minimum(quoted_output: int, slippage_bps: int) -> int:
    quoted_output = int(quoted_output)
    slippage_bps = int(slippage_bps)
    if quoted_output <= 0:
        raise ValueError("pool quote must be positive")
    if slippage_bps < 0 or slippage_bps >= 10_000:
        raise ValueError("slippage must be between 0 and 9999 bps")
    return max(1, quoted_output * (10_000 - slippage_bps) // 10_000)


def _force_pool_price_allowed(
    *,
    chain_id: int,
    strategy_id: str,
    authorized_strategy_id: Optional[str],
) -> bool:
    if authorized_strategy_id is None:
        return False
    if int(chain_id) != 11155111:
        raise ValueError("pool-price recovery override is Sepolia-only")
    if str(authorized_strategy_id) != str(strategy_id):
        raise ValueError("pool-price override strategy does not match recovery strategy")
    return True


def _save_stage(path: str, journal: dict, stage: str, **updates) -> dict:
    journal.update(updates)
    journal["stage"] = stage
    journal["updated_at"] = datetime.utcnow().isoformat() + "Z"
    _write_journal(path, journal)
    return journal


def _build_swap_transaction(
    w3, account, chain, plan: RecoveryPlan, deadline: Optional[int] = None
):
    from evm_executor import (
        SIMPLE_SWAP_ROUTER_POOL_ABI,
        SWAP_ROUTER_02_ABI,
        SWAP_ROUTER_V3_ABI,
        _router_uses_classic_v3,
        _router_uses_simple_pool_swap,
        _router_uses_swap_router_02,
    )

    if _router_uses_simple_pool_swap(w3, plan.router):
        if deadline is None:
            raise ValueError("simple pool recovery swap requires a fixed deadline")
        router = w3.eth.contract(address=plan.router, abi=SIMPLE_SWAP_ROUTER_POOL_ABI)
        params = (
            plan.usdc,
            plan.weth,
            plan.pool_fee,
            plan.executor,
            int(deadline),
            plan.amounts.swap_amount,
            plan.amount_out_minimum,
            0,
        )
        call = router.functions.exactInputSingleWithPool(plan.pool, params)
    elif _router_uses_classic_v3(w3, plan.router):
        if deadline is None:
            raise ValueError("classic V3 recovery swap requires a fixed deadline")
        router = w3.eth.contract(address=plan.router, abi=SWAP_ROUTER_V3_ABI)
        params = (
            plan.usdc,
            plan.weth,
            plan.pool_fee,
            plan.executor,
            int(deadline),
            plan.amounts.swap_amount,
            plan.amount_out_minimum,
            0,
        )
        call = router.functions.exactInputSingle(params)
    elif _router_uses_swap_router_02(w3, plan.router):
        router = w3.eth.contract(address=plan.router, abi=SWAP_ROUTER_02_ABI)
        params = (
            plan.usdc,
            plan.weth,
            plan.pool_fee,
            plan.executor,
            plan.amounts.swap_amount,
            plan.amount_out_minimum,
            0,
        )
        call = router.functions.exactInputSingle(params)
    else:
        raise ValueError("configured router has no supported exactInputSingle selector")
    return call.build_transaction(
        {"from": account.address, "value": 0, "gas": SWAP_GAS_FLOOR}
    )


def _prepare_signed_action(w3, account, tx_params: dict, action: str) -> dict:
    """Fully sign a transaction so its deterministic hash can be journaled before broadcast."""
    tx = dict(tx_params)
    tx.setdefault("from", account.address)
    tx.setdefault("nonce", w3.eth.get_transaction_count(account.address, "pending"))
    tx.setdefault("chainId", int(w3.eth.chain_id))
    gas_floor = int(tx.pop("gas", 0) or 0)
    try:
        estimate = int(w3.eth.estimate_gas(dict(tx)))
        tx["gas"] = max(gas_floor, int(estimate * 1.3))
    except Exception:
        if not gas_floor:
            raise
        # Recovery commonly signs the deposit immediately after an unwrap. If
        # estimate_gas reaches a stale RPC replica, preserve the explicit safe
        # floor rather than abandoning the journal at the custody boundary.
        tx["gas"] = gas_floor
    fees = fee_params(w3, int(tx["chainId"]))
    tx.update(fees)
    max_cost = int(tx.get("value", 0)) + tx["gas"] * tx["maxFeePerGas"]
    value = int(tx.get("value", 0) or 0)
    balance_attempts = 15 if value else 1
    balance = wait_for_sufficient_balance(
        w3,
        account.address,
        max_cost,
        attempts=balance_attempts,
    )
    if balance < max_cost:
        raise ValueError(
            f"executor needs {max_cost} wei for {action}, has {balance}"
        )
    signed = account.sign_transaction(tx)
    raw = bytes(signed.rawTransaction)
    tx_hash = w3.keccak(raw).hex()
    return {
        "action": action,
        "tx_hash": tx_hash,
        "raw_transaction": "0x" + raw.hex(),
        "nonce": int(tx["nonce"]),
        "to": Web3.to_checksum_address(tx["to"]),
        "value": int(tx.get("value", 0)),
        "prepared_at": datetime.utcnow().isoformat() + "Z",
    }


def _confirm_prepared_action(w3, pending: dict):
    """Reconcile or broadcast one pre-journaled transaction; never construct a replacement."""
    tx_hash = pending["tx_hash"]
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound:
        raw = bytes.fromhex(pending["raw_transaction"][2:])
        try:
            broadcast_hash = w3.eth.send_raw_transaction(raw).hex()
            if broadcast_hash.lower() != tx_hash.lower():
                raise RuntimeError("broadcast hash differs from pre-journaled hash")
        except Exception as exc:
            message = str(exc).lower()
            if not any(value in message for value in ("already known", "nonce too low")):
                raise
        receipt = w3.eth.wait_for_transaction_receipt(
            tx_hash, timeout=600, poll_latency=2
        )
    if int(receipt.status) != 1:
        raise RuntimeError(
            f"pre-journaled {pending['action']} reverted: {tx_hash}"
        )
    return receipt


def _prepare_pending_action(
    journal_path: str,
    journal: dict,
    w3,
    account,
    tx_params: dict,
    action: str,
) -> dict:
    if journal.get("pending_action"):
        raise RuntimeError("cannot prepare a second transaction while one is pending")
    journal["pending_action"] = _prepare_signed_action(
        w3, account, tx_params, action
    )
    return _save_stage(journal_path, journal, journal["stage"])


def _reconcile_pending_action(
    journal_path: str,
    journal: dict,
    w3,
    plan: RecoveryPlan,
) -> dict:
    from evm_executor import token_received_in_tx

    pending = journal.get("pending_action")
    if not pending:
        return journal
    _confirm_prepared_action(w3, pending)
    action = pending["action"]
    tx_hash = pending["tx_hash"]
    journal.pop("pending_action", None)
    if action == "approve_reset":
        return _save_stage(journal_path, journal, "planned", approve_reset_tx=tx_hash)
    if action == "approve":
        return _save_stage(journal_path, journal, "approved", approve_tx=tx_hash)
    if action == "swap":
        received_weth = token_received_in_tx(
            w3, tx_hash, plan.weth, plan.executor
        )
        signed_minimum = int(journal["plan"]["amount_out_minimum"])
        if received_weth < signed_minimum:
            raise RuntimeError("confirmed recovery swap output is below its minimum")
        return _save_stage(
            journal_path,
            journal,
            "swapped",
            swap_tx=tx_hash,
            received_weth=received_weth,
        )
    if action == "unwrap":
        return _save_stage(journal_path, journal, "unwrapped", unwrap_tx=tx_hash)
    if action == "deposit":
        return _save_stage(journal_path, journal, "deposited", deposit_tx=tx_hash)
    raise RuntimeError(f"unknown pending recovery action {action!r}")


def _revoke_router_allowance(
    *,
    journal_path: str,
    journal: dict,
    w3,
    account,
    token,
    plan: RecoveryPlan,
) -> dict:
    """Crash-safely remove a recovery approval after swap preflight fails."""
    allowance = int(token.functions.allowance(plan.executor, plan.router).call())
    if allowance == 0:
        if journal.get("stage") in {"approved", "simulated"}:
            return _save_stage(
                journal_path, journal, "planned", allowance_revoked=True
            )
        return journal
    tx = token.functions.approve(plan.router, 0).build_transaction(
        {"from": plan.executor, "gas": 120_000}
    )
    journal = _prepare_pending_action(
        journal_path, journal, w3, account, tx, "approve_reset"
    )
    return _reconcile_pending_action(journal_path, journal, w3, plan)


def _update_strategy_recovered(database_path: str, plan: RecoveryPlan, journal: dict) -> None:
    audit = {
        "recovered": True,
        "withdraw_tx": plan.withdraw_tx,
        "receipt_payout": plan.amounts.receipt_payout,
        "vault_fee": plan.amounts.vault_fee,
        "execution_fee": plan.amounts.execution_fee,
        "swap_amount": plan.amounts.swap_amount,
        "swap_tx": journal["swap_tx"],
        "unwrap_tx": journal["unwrap_tx"],
        "deposit_tx": journal["deposit_tx"],
    }
    db = sqlite3.connect(database_path)
    try:
        current = db.execute(
            "SELECT status, tx_hash FROM strategy WHERE id = ?",
            (plan.strategy_id,),
        ).fetchone()
        if current is None:
            raise RuntimeError("strategy disappeared during recovery finalization")
        if current[0] == "EXECUTED" and str(current[1]).lower() == journal["deposit_tx"].lower():
            return
        if current[0] != "FAILED":
            raise RuntimeError(
                f"strategy status changed during recovery: {current[0]}"
            )
        result = db.execute(
            """
            UPDATE strategy
            SET status = 'EXECUTED', tx_hash = ?, executed_at = ?, execution_error = ?
            WHERE id = ? AND status = 'FAILED'
            """,
            (
                journal["deposit_tx"],
                datetime.utcnow().isoformat(),
                json.dumps(audit, sort_keys=True),
                plan.strategy_id,
            ),
        )
        if result.rowcount != 1:
            raise RuntimeError("strategy database finalization did not update one row")
        db.commit()
    finally:
        db.close()


def execute_recovery(
    *,
    plan: RecoveryPlan,
    database_path: str,
    indexer_db_uri: str,
    data_dir: str,
    force_sepolia_pool_price_for: Optional[str] = None,
) -> dict:
    from evm_chain_config import get_evm_chain_config
    from evm_executor import (
        ERC20_ABI,
        ENTRYPOINT_ABI,
        WETH_ABI,
        get_executor_account,
        get_web3,
    )

    force_sepolia_pool_price = _force_pool_price_allowed(
        chain_id=plan.chain_id,
        strategy_id=plan.strategy_id,
        authorized_strategy_id=force_sepolia_pool_price_for,
    )

    os.makedirs(data_dir, exist_ok=True)
    journal_path = os.path.join(data_dir, f"recovery-{plan.strategy_id}.json")
    lock_path = os.path.join(data_dir, f"recovery-{plan.strategy_id}.lock")
    with open(lock_path, "w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal = _load_journal(journal_path)
        if journal is None:
            journal = {
                "stage": "planned",
                "created_at": datetime.utcnow().isoformat() + "Z",
                "plan": plan.to_dict(),
            }
            _write_journal(journal_path, journal)
        elif _plan_identity(journal.get("plan", {})) != _plan_identity(plan.to_dict()):
            raise ValueError("recovery plan does not match the existing journal")

        chain = get_evm_chain_config(plan.chain_id)
        w3 = get_web3(chain)
        account = get_executor_account(w3, plan.chain_id)
        if Web3.to_checksum_address(account.address) != plan.executor:
            raise ValueError("runtime signer no longer matches the recovery plan")

        existing_deposit = _find_output_deposit(
            indexer_db_uri, plan.chain_id, plan.output_precommitment
        )
        if existing_deposit:
            known_deposit = journal.get("deposit_tx")
            pending = journal.get("pending_action") or {}
            if not known_deposit and pending.get("action") == "deposit":
                known_deposit = pending.get("tx_hash")
            if not known_deposit or str(known_deposit).lower() != str(
                existing_deposit["tx_hash"]
            ).lower():
                raise ValueError("output precommitment has an unrelated indexed deposit")
            journal.pop("pending_action", None)
            journal = _save_stage(
                journal_path,
                journal,
                "deposited",
                deposit_tx=str(existing_deposit["tx_hash"]),
                indexed_deposit=existing_deposit,
            )

        journal = _reconcile_pending_action(journal_path, journal, w3, plan)
        token = w3.eth.contract(address=plan.usdc, abi=ERC20_ABI)

        while True:
            stage = journal["stage"]
            if stage in {"planned", "approved", "simulated"}:
                if int(token.functions.balanceOf(plan.executor).call()) < plan.amounts.swap_amount:
                    raise ValueError(
                        "executor USDC balance is below the receipt-derived recovery amount"
                    )

            if stage == "planned":
                allowance = int(
                    token.functions.allowance(plan.executor, plan.router).call()
                )
                if allowance == plan.amounts.swap_amount:
                    journal = _save_stage(journal_path, journal, "approved")
                    continue
                if allowance:
                    tx = token.functions.approve(plan.router, 0).build_transaction(
                        {"from": plan.executor, "gas": 120_000}
                    )
                    action = "approve_reset"
                else:
                    tx = token.functions.approve(
                        plan.router, plan.amounts.swap_amount
                    ).build_transaction({"from": plan.executor, "gas": 120_000})
                    action = "approve"
                journal = _prepare_pending_action(
                    journal_path, journal, w3, account, tx, action
                )
                journal = _reconcile_pending_action(journal_path, journal, w3, plan)
                continue

            if stage == "approved":
                if int(token.functions.allowance(plan.executor, plan.router).call()) != plan.amounts.swap_amount:
                    journal = _save_stage(journal_path, journal, "planned")
                    continue
                deadline = int(time.time()) + 300
                try:
                    effective_plan = plan
                    journal["plan"]["eth_usd_price"] = plan.eth_usd_price
                    if force_sepolia_pool_price:
                        probe_plan = replace(plan, amount_out_minimum=1)
                        probe_tx = _build_swap_transaction(
                            w3, account, chain, probe_plan, deadline=deadline
                        )
                        pool_quote = int.from_bytes(w3.eth.call(probe_tx), "big")
                        forced_minimum = _pool_relative_minimum(
                            pool_quote, plan.slippage_bps
                        )
                        effective_plan = replace(
                            plan, amount_out_minimum=forced_minimum
                        )
                        journal["plan"]["oracle_amount_out_minimum"] = (
                            plan.amount_out_minimum
                        )
                        journal["plan"]["forced_sepolia_pool_price"] = True
                        journal["plan"]["pool_quote"] = pool_quote
                    else:
                        journal["plan"].pop("oracle_amount_out_minimum", None)
                        journal["plan"].pop("forced_sepolia_pool_price", None)
                        journal["plan"].pop("pool_quote", None)
                    journal["plan"]["amount_out_minimum"] = (
                        effective_plan.amount_out_minimum
                    )
                    journal = _save_stage(journal_path, journal, "approved")
                    swap_tx = _build_swap_transaction(
                        w3, account, chain, effective_plan, deadline=deadline
                    )
                    simulated = int.from_bytes(w3.eth.call(swap_tx), "big")
                    if simulated < effective_plan.amount_out_minimum:
                        raise ValueError(
                            "router simulation is below the signed recovery minimum"
                        )
                except Exception as preflight_error:
                    try:
                        journal = _revoke_router_allowance(
                            journal_path=journal_path,
                            journal=journal,
                            w3=w3,
                            account=account,
                            token=token,
                            plan=plan,
                        )
                    except Exception as revoke_error:
                        raise RuntimeError(
                            "swap preflight failed and recovery allowance revocation "
                            f"also failed: {revoke_error}"
                        ) from preflight_error
                    raise
                journal = _save_stage(
                    journal_path,
                    journal,
                    "simulated",
                    simulated_weth=simulated,
                    swap_deadline=deadline,
                )
                journal = _prepare_pending_action(
                    journal_path, journal, w3, account, swap_tx, "swap"
                )
                journal = _reconcile_pending_action(journal_path, journal, w3, plan)
                continue

            if stage == "simulated":
                journal = _save_stage(journal_path, journal, "approved")
                continue

            if stage == "swapped":
                received_weth = int(journal["received_weth"])
                weth_token = w3.eth.contract(address=plan.weth, abi=ERC20_ABI)
                if int(weth_token.functions.balanceOf(plan.executor).call()) < received_weth:
                    raise ValueError(
                        "executor WETH balance is below the receipt-attributed swap output"
                    )
                weth = w3.eth.contract(address=plan.weth, abi=WETH_ABI)
                unwrap_tx = weth.functions.withdraw(received_weth).build_transaction(
                    {"from": plan.executor, "gas": 120_000}
                )
                journal = _prepare_pending_action(
                    journal_path, journal, w3, account, unwrap_tx, "unwrap"
                )
                journal = _reconcile_pending_action(journal_path, journal, w3, plan)
                continue

            if stage == "unwrapped":
                received_weth = int(journal["received_weth"])
                entrypoint = w3.eth.contract(
                    address=Web3.to_checksum_address(chain.entrypoint), abi=ENTRYPOINT_ABI
                )
                deposit_tx = entrypoint.functions.deposit(
                    Web3.to_checksum_address(
                        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
                    ),
                    received_weth,
                    int(plan.output_precommitment),
                ).build_transaction(
                    {
                        "from": plan.executor,
                        "value": received_weth,
                        "gas": NATIVE_VAULT_GAS_FLOOR,
                    }
                )
                journal = _prepare_pending_action(
                    journal_path, journal, w3, account, deposit_tx, "deposit"
                )
                journal = _reconcile_pending_action(journal_path, journal, w3, plan)
                continue

            if stage == "deposited":
                _update_strategy_recovered(database_path, plan, journal)
                journal = _save_stage(journal_path, journal, "complete")
                continue

            if stage == "complete":
                return journal
            raise RuntimeError(f"invalid recovery journal stage {stage!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strategy-id", required=True)
    parser.add_argument("--withdraw-tx", required=True)
    parser.add_argument("--expected-executor", required=True)
    parser.add_argument("--expected-swap-amount", required=True, type=int)
    parser.add_argument("--database-path", default="/app/data/strategies.db")
    parser.add_argument("--data-dir", default="/app/data")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument(
        "--force-sepolia-pool-price-for",
        metavar="STRATEGY_ID",
        help=(
            "Sepolia recovery only: for this exact strategy ID, replace the "
            "oracle minimum with a fresh pool quote minus the strategy "
            "slippage tolerance"
        ),
    )
    args = parser.parse_args()

    plan = build_recovery_plan(
        database_path=args.database_path,
        strategy_id=args.strategy_id,
        withdraw_tx=args.withdraw_tx,
        expected_executor=args.expected_executor,
    )
    if plan.amounts.swap_amount != args.expected_swap_amount:
        raise ValueError(
            f"expected swap amount {args.expected_swap_amount} does not match "
            f"receipt-derived amount {plan.amounts.swap_amount}"
        )
    force_sepolia_pool_price = _force_pool_price_allowed(
        chain_id=plan.chain_id,
        strategy_id=plan.strategy_id,
        authorized_strategy_id=args.force_sepolia_pool_price_for,
    )
    existing = _find_output_deposit(
        os.environ.get("INDEXER_DB_URI", ""), plan.chain_id, plan.output_precommitment
    )
    if existing and not args.execute:
        raise ValueError(f"output precommitment is already deposited: {existing}")
    print(
        json.dumps(
            {
                "mode": "execute" if args.execute else "dry-run",
                "force_sepolia_pool_price": force_sepolia_pool_price,
                "force_sepolia_pool_price_for": args.force_sepolia_pool_price_for,
                "plan": plan.to_dict(),
                "existing_output_deposit": existing,
            },
            indent=2,
        )
    )
    if not args.execute:
        return 0
    result = execute_recovery(
        plan=plan,
        database_path=args.database_path,
        indexer_db_uri=os.environ.get("INDEXER_DB_URI", ""),
        data_dir=args.data_dir,
        force_sepolia_pool_price_for=args.force_sepolia_pool_price_for,
    )
    print(json.dumps({"status": "recovered", "journal": result}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Devnet settle: client Groth16 spend, Meteora / Jupiter Earn / Jito stake, vault return.

The browser proves a WITHDRAW of the order's note to this process's settlement wallet and, for
output_mode='vault', sends the precommitment + label salt of the note it wants back. When the order
fires, the venue script spends, settles the public leg, and deposits the output under the user's
precommitment. STAGED settlements resume via process_staged() on the next scheduler tick.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

SOLANA_DEVNET_CHAIN_ID = 900_002
WSOL_MINT = "So11111111111111111111111111111111111111112"
ZK_PROGRAM_ID = (
    os.getenv("SIPHON_ZK_PROGRAM_ID")
    or os.getenv("NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID")
    or "BktHHQ8KJpfnwLNMEqnh9uANEyuFa1qYtbhzHwCKMEDe"
)
# Meteora settlement script. SIPHON_METEORA_SCRIPT overrides; the executor image ships a copy under
# solana-scripts/ (same pattern as relay-zk-withdraw.mjs).
_HERE = Path(__file__).resolve()


def _meteora_script() -> Path:
    explicit = (os.getenv("SIPHON_METEORA_SCRIPT") or "").strip()
    if explicit:
        return Path(explicit)
    bundled = _HERE.parent / "solana-scripts" / "execute-zk-meteora.mjs"
    if bundled.is_file():
        return bundled
    monorepo = (
        (_HERE.parents[2] if len(_HERE.parents) > 2 else _HERE.parent)
        / "siphon-contracts-v2"
        / "solana"
        / "scripts"
        / "execute-zk-meteora.mjs"
    )
    return monorepo


def _earn_script() -> Path:
    explicit = (os.getenv("SIPHON_JUPITER_EARN_SCRIPT") or "").strip()
    if explicit:
        return Path(explicit)
    bundled = _HERE.parent / "solana-scripts" / "execute-zk-jupiter-earn.mjs"
    if bundled.is_file():
        return bundled
    return (
        (_HERE.parents[2] if len(_HERE.parents) > 2 else _HERE.parent)
        / "siphon-contracts-v2"
        / "solana"
        / "scripts"
        / "execute-zk-jupiter-earn.mjs"
    )


def _jito_script() -> Path:
    explicit = (os.getenv("SIPHON_JITO_STAKE_SCRIPT") or "").strip()
    if explicit:
        return Path(explicit)
    bundled = _HERE.parent / "solana-scripts" / "execute-zk-jito-stake.mjs"
    if bundled.is_file():
        return bundled
    return (
        (_HERE.parents[2] if len(_HERE.parents) > 2 else _HERE.parent)
        / "siphon-contracts-v2"
        / "solana"
        / "scripts"
        / "execute-zk-jito-stake.mjs"
    )


_SCRIPT = _meteora_script()

JL_USDC_MINT = (
    os.getenv("JUPITER_JL_USDC_MINT")
    or os.getenv("NEXT_PUBLIC_JUPITER_JL_USDC_MINT")
    or "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu"
)
EARN_ASSET_MINT = (
    os.getenv("JUPITER_EARN_ASSET_MINT")
    or os.getenv("SOLANA_USDC_MINT")
    or os.getenv("NEXT_PUBLIC_SOLANA_USDC_MINT")
    or "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
)
LENDING_PROGRAM = (
    os.getenv("JUPITER_LEND_PROGRAM")
    or "7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3"
)
JITO_SOL_MINT = (
    os.getenv("JITO_SOL_MINT")
    or os.getenv("NEXT_PUBLIC_JITO_SOL_MINT")
    or "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi"
)
JITO_STAKE_POOL = (
    os.getenv("JITO_STAKE_POOL")
    or os.getenv("NEXT_PUBLIC_JITO_STAKE_POOL")
    or "JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ"
)


def _load_keypair():
    from solders.keypair import Keypair

    keypair_raw = (os.getenv("SOLANA_RELAYER_KEYPAIR") or "").strip()
    if not keypair_raw:
        default_kp = Path.home() / ".config" / "solana" / "id.json"
        if default_kp.is_file():
            keypair_raw = default_kp.read_text(encoding="utf-8").strip()
    if not keypair_raw:
        raise RuntimeError("SOLANA_RELAYER_KEYPAIR required for Devnet Meteora settlement")
    if keypair_raw.startswith("["):
        return Keypair.from_bytes(bytes(json.loads(keypair_raw)))
    try:
        return Keypair.from_base58_string(keypair_raw)
    except ValueError:
        return Keypair.from_bytes(base64.b64decode(keypair_raw, validate=True))


def settlement_pubkey() -> str:
    return str(_load_keypair().pubkey())


def _validate_common_spend(zkp: dict, *, settlement: Optional[str], vault_output: bool) -> Optional[str]:
    publics = zkp.get("publics")
    if not isinstance(publics, list) or len(publics) != 25:
        return "publics must be 25 limbs"
    proof = str(zkp.get("proof_hex") or "")
    if len(proof) != 512:
        return "proof_hex must be 256 bytes"
    binder = str(zkp.get("binder_hex") or "")
    if len(binder) != 64:
        return "binder_hex must be 32 bytes"
    nullifiers = zkp.get("nullifiers_hex")
    if not isinstance(nullifiers, list) or not nullifiers:
        return "nullifiers_hex required"
    if not str(zkp.get("mint") or "").strip():
        return "mint required"
    if not str(zkp.get("settlement") or "").strip():
        return "settlement required"
    if zkp.get("circuit_index") is None:
        return "circuit_index required"
    if str(publics[0]) != "0":
        return "the spend must be a WITHDRAW (action 0) to the settlement wallet"
    if settlement and str(zkp.get("settlement")) != settlement:
        return "the proof pays another wallet than this executor's settlement wallet"
    if vault_output:
        try:
            ok = int(str(zkp.get("return_precommitment") or "0")) > 0 and \
                int(str(zkp.get("return_user_salt") or "0")) > 0
        except ValueError:
            ok = False
        if not ok:
            return "output_mode=vault needs return_precommitment and a non-zero return_user_salt"
    return None


def validate_meteora_zk_package(zkp: dict, *, settlement: Optional[str] = None,
                                vault_output: bool = False) -> Optional[str]:
    """Return an error string, or None when the package can be submitted."""
    if not isinstance(zkp, dict):
        return "zkp_data must be an object"
    if zkp.get("venue") != "meteora-dlmm":
        return "venue must be meteora-dlmm"
    err = _validate_common_spend(zkp, settlement=settlement, vault_output=vault_output)
    if err:
        return err
    if not str(zkp.get("meteora_pool") or "").strip():
        return "meteora_pool required"
    return None


def validate_jupiter_earn_zk_package(zkp: dict, *, settlement: Optional[str] = None,
                                     vault_output: bool = False) -> Optional[str]:
    """Validate a Jupiter Earn Enter/Exit package."""
    if not isinstance(zkp, dict):
        return "zkp_data must be an object"
    if zkp.get("venue") != "jupiter-earn":
        return "venue must be jupiter-earn"
    err = _validate_common_spend(zkp, settlement=settlement, vault_output=vault_output)
    if err:
        return err
    action = str(zkp.get("action") or "").strip().lower()
    if action not in ("enter", "exit"):
        return "action must be enter or exit"
    for key in ("asset_mint", "jl_token_mint"):
        if not str(zkp.get(key) or "").strip():
            return f"{key} required"
    return None


def validate_jito_stake_zk_package(zkp: dict, *, settlement: Optional[str] = None,
                                   vault_output: bool = False) -> Optional[str]:
    """Validate a Jito stake Enter/Exit package."""
    if not isinstance(zkp, dict):
        return "zkp_data must be an object"
    if zkp.get("venue") != "jito-stake":
        return "venue must be jito-stake"
    err = _validate_common_spend(zkp, settlement=settlement, vault_output=vault_output)
    if err:
        return err
    action = str(zkp.get("action") or "").strip().lower()
    if action not in ("enter", "exit"):
        return "action must be enter or exit"
    if not str(zkp.get("jito_sol_mint") or JITO_SOL_MINT).strip():
        return "jito_sol_mint required"
    return None


def validate_devnet_zk_package(zkp: dict, *, settlement: Optional[str] = None,
                               vault_output: bool = False) -> Optional[str]:
    """Dispatch package validation by venue."""
    if not isinstance(zkp, dict):
        return "zkp_data must be an object"
    venue = zkp.get("venue")
    if venue == "jupiter-earn":
        return validate_jupiter_earn_zk_package(zkp, settlement=settlement, vault_output=vault_output)
    if venue == "jito-stake":
        return validate_jito_stake_zk_package(zkp, settlement=settlement, vault_output=vault_output)
    if venue == "meteora-dlmm":
        return validate_meteora_zk_package(zkp, settlement=settlement, vault_output=vault_output)
    return "venue must be meteora-dlmm, jupiter-earn, or jito-stake"


def validate_pipeline_hop_skeleton(zkp: dict) -> Optional[str]:
    """Hops 1..N at arm time: venue + settlement metadata only (no Groth16 yet)."""
    if not isinstance(zkp, dict):
        return "zkp_data must be an object"
    venue = zkp.get("venue")
    if venue not in ("meteora-dlmm", "jupiter-earn", "jito-stake"):
        return "venue must be meteora-dlmm, jupiter-earn, or jito-stake"
    if not str(zkp.get("settlement") or "").strip():
        return "settlement required"
    if venue == "jupiter-earn":
        action = str(zkp.get("action") or "").strip().lower()
        if action not in ("enter", "exit"):
            return "action must be enter or exit"
        for key in ("asset_mint", "jl_token_mint"):
            if not str(zkp.get(key) or "").strip():
                return f"{key} required"
    elif venue == "jito-stake":
        action = str(zkp.get("action") or "").strip().lower()
        if action not in ("enter", "exit"):
            return "action must be enter or exit"
    elif venue == "meteora-dlmm":
        if not str(zkp.get("meteora_pool") or zkp.get("meteora_pair") or "").strip():
            return "meteora_pool or meteora_pair required"
        if not str(zkp.get("solana_side") or "").strip():
            return "solana_side required"
    # return note secrets are sealed; precommitment optional on skeleton (filled at prove time)
    return None


def resolve_swap_side(strategy: dict) -> str:
    """Return 'sell_usdc' or 'sell_wsol' from strategy fields / note mint hint."""
    zkp = strategy.get("zkp_data") or {}
    if isinstance(zkp, str):
        try:
            zkp = json.loads(zkp)
        except Exception:
            zkp = {}
    side = (
        strategy.get("solana_side")
        or zkp.get("solana_side")
        or ""
    ).strip().lower()
    if side in ("sell_usdc", "usdc_to_wsol", "limit_sell", "sell"):
        return "sell_usdc"
    if side in ("sell_wsol", "wsol_to_usdc", "limit_buy", "buy"):
        return "sell_wsol"

    asset_in = (strategy.get("asset_in") or "").upper()
    asset_out = (strategy.get("asset_out") or "").upper()
    stype = (strategy.get("strategy_type") or "").upper()
    if "BUY" in stype or (asset_in in ("SOL", "WSOL") and asset_out == "USDC"):
        return "sell_wsol"
    if "SELL" in stype or (asset_in == "USDC" and asset_out in ("SOL", "WSOL")):
        return "sell_usdc"

    mint = (strategy.get("solana_mint") or zkp.get("solana_mint") or zkp.get("mint") or "").strip()
    if mint == WSOL_MINT:
        return "sell_wsol"
    return "sell_usdc"


def _zkp(strategy: dict) -> dict:
    zkp = strategy.get("zkp_data") or {}
    if isinstance(zkp, str):
        try:
            zkp = json.loads(zkp)
        except Exception:
            zkp = {}
    return zkp if isinstance(zkp, dict) else {}


# One settlement wallet: the script measures every amount as a balance DELTA on it, so two
# settlements at once (the scheduler thread and a gunicorn request) would read each other's funds.
_SETTLE_LOCK = threading.Lock()
SETTLE_TIMEOUT = int(os.getenv("SOLANA_SETTLE_TIMEOUT", "300"))
_EXIT = {3: "NEEDS_REPROOF", 4: "NO_ROUTE", 5: "STAGED"}


def _parse_lines(out) -> tuple[dict, Optional[dict]]:
    """(final line, last resume state). A crash after a stage line still leaves the stage."""
    if isinstance(out, bytes):
        out = out.decode("utf-8", "replace")
    final: dict = {}
    resume: Optional[dict] = None
    for line in (out or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj.get("resume"), dict):
            resume = obj["resume"]
        if "ok" in obj:
            final = obj
    return final, resume


def settle(strategy: dict, zkp: dict, resume: Optional[dict] = None) -> dict[str, Any]:
    """One settlement attempt for a fired Devnet order (or leg).

    status: EXECUTED | NEEDS_REPROOF (nothing sent) | NO_ROUTE (nothing sent) | STAGED (funds
    moved part way — persist `settlement` and resume) | FAILED. `settlement` is what the row keeps.
    """
    vault = (strategy.get("output_mode") or "address").lower() == "vault"
    err = validate_devnet_zk_package(zkp, vault_output=vault)
    if err:
        return {"ok": False, "status": "FAILED", "error": err}
    venue = zkp.get("venue")
    if venue == "jupiter-earn":
        script = _earn_script()
    elif venue == "jito-stake":
        script = _jito_script()
    else:
        script = _meteora_script()
    if not script.is_file():
        return {"ok": False, "status": "FAILED", "error": f"missing {script}"}
    payload: dict[str, Any] = {
        **zkp,
        "program_id": ZK_PROGRAM_ID,
        "slippage_bps": int(strategy.get("max_slippage_bps") or 50),
    }
    if venue == "jupiter-earn":
        payload.setdefault("asset_mint", EARN_ASSET_MINT)
        payload.setdefault("jl_token_mint", JL_USDC_MINT)
        payload.setdefault("lending_program", LENDING_PROGRAM)
    if venue == "jito-stake":
        payload.setdefault("jito_sol_mint", JITO_SOL_MINT)
        payload.setdefault("stake_pool", JITO_STAKE_POOL)

    # Prefer live env pools over arm-time package when set. Pair-specific pools beat METEORA_POOL
    # so jlUSDC/JitoSOL sells do not get forced onto the USDC/SOL pool.
    pair = str(zkp.get("meteora_pair") or "").strip().lower()
    jl_pool = (os.getenv("METEORA_JLUSDC_SOL_POOL") or "").strip()
    jito_pool = (os.getenv("METEORA_JITOSOL_SOL_POOL") or "").strip()
    pool_env = (os.getenv("METEORA_POOL") or "").strip()
    if pair in ("jlusdc_sol", "jl_usdc_sol") and jl_pool:
        payload["meteora_pool"] = jl_pool
    elif pair in ("jitosol_sol", "jito_sol") and jito_pool:
        payload["meteora_pool"] = jito_pool
    elif pool_env and pair in ("", "usdc_sol"):
        payload["meteora_pool"] = pool_env
    if vault:
        payload["return"] = {"precommitment": str(zkp["return_precommitment"]),
                             "user_salt": str(zkp["return_user_salt"])}
    else:
        recipient = (strategy.get("recipient_address") or strategy.get("recipient") or "").strip()
        if not recipient:
            return {"ok": False, "status": "FAILED", "error": "recipient_address required"}
        payload["recipient"] = recipient
    if resume:
        payload["resume"] = resume

    env = os.environ.copy()
    env.setdefault("SOLANA_RPC_URL", "https://api.devnet.solana.com")
    env.setdefault("SIPHON_ZK_PROGRAM_ID", ZK_PROGRAM_ID)
    # execute-zk-meteora.mjs screens the return note via solasp (vault output_mode).
    env.setdefault("SOLASP_URL", (os.getenv("SOLASP_URL") or os.getenv("ASP_URL") or "").strip())
    env.setdefault(
        "SOLASP_SCREEN_TOKEN",
        (os.getenv("SOLASP_SCREEN_TOKEN") or os.getenv("ASP_SCREEN_TOKEN") or "").strip(),
    )
    with _SETTLE_LOCK:
        try:
            proc = subprocess.run(
                ["node", str(script)], input=json.dumps(payload), capture_output=True, text=True,
                timeout=SETTLE_TIMEOUT, env=env, cwd=str(script.parent), check=False,
            )
            out, code, stderr = proc.stdout, proc.returncode, proc.stderr
        except subprocess.TimeoutExpired as exc:
            out, code, stderr = exc.stdout, None, "settlement timed out"
    final, staged = _parse_lines(out)

    if code == 0 and final.get("ok"):
        return {**final, "ok": True, "status": "EXECUTED", "tx_hash": final.get("spend_sig"),
                "settlement": final}
    status = _EXIT.get(code) or ("STAGED" if staged else "FAILED")
    if status == "STAGED" and not staged:
        staged = final.get("resume")
    msg = final.get("error") or (stderr or "").strip()[-500:] or f"node exit {code}"
    out_ = {"ok": False, "status": status, "code": final.get("code") or status, "error": msg,
            "message": msg}
    if status == "STAGED":
        out_["settlement"] = staged
    return out_


def _relay_script() -> Path:
    """The withdraw relay. A monorepo checkout has it beside the Meteora script; the executor
    image does not, so it ships a copy under solana-scripts/."""
    explicit = (os.getenv("SIPHON_RELAY_WITHDRAW_SCRIPT") or "").strip()
    if explicit:
        return Path(explicit)
    sibling = _meteora_script().parent / "relay-zk-withdraw.mjs"
    if sibling.is_file():
        return sibling
    return _HERE.parent / "solana-scripts" / "relay-zk-withdraw.mjs"


def relay_withdraw(pkg: dict, recipient: Optional[str] = None) -> dict[str, Any]:
    """Submit a browser-proved Devnet WITHDRAW (or a SPLIT, given split_commitments_hex) from the
    settlement wallet (commit + spend), so the user signs nothing and pays no fee. A withdraw's
    proof binds the payee; the relayer cannot redirect it."""
    script = _relay_script()
    if not script.is_file():
        return {"ok": False, "code": "FAILED", "error": f"missing {script}"}
    payload = {k: pkg.get(k) for k in ("publics", "proof_hex", "binder_hex", "nullifiers_hex",
                                       "circuit_index", "mint", "split_commitments_hex")
               if pkg.get(k) is not None}
    payload.update(program_id=ZK_PROGRAM_ID, **({"recipient": recipient} if recipient else {}))
    env = os.environ.copy()
    env.setdefault("SOLANA_RPC_URL", "https://api.devnet.solana.com")
    with _SETTLE_LOCK:
        try:
            proc = subprocess.run(["node", str(script)], input=json.dumps(payload), capture_output=True,
                                  text=True, timeout=SETTLE_TIMEOUT, env=env, cwd=str(script.parent),
                                  check=False)
            out, stderr = proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as exc:
            out, stderr = exc.stdout, "relay timed out"
    final, _ = _parse_lines(out)
    if final.get("ok"):
        return final
    return {"ok": False, "code": final.get("code") or "FAILED",
            "error": final.get("error") or (stderr or "").strip()[-400:] or "relay failed"}


def execute_meteora_zk(strategy: dict) -> dict[str, Any]:
    """Settle a single Devnet order from its row dict (kept for /executeStrategy callers)."""
    return settle(strategy, _zkp(strategy), (strategy.get("settlement") or {}).get("resume")
                  if isinstance(strategy.get("settlement"), dict) else None)


def _record(row, result: dict, *, is_leg: bool) -> None:
    """Persist one settle outcome on a Strategy or StrategyLeg row."""
    from datetime import datetime

    from database import db

    status = result["status"]
    if status == "EXECUTED":
        row.status = "EXECUTED"
        row.tx_hash = result.get("tx_hash")
        row.executed_at = datetime.utcnow()
        row.settlement = json.dumps(result.get("settlement") or {})
    elif status == "STAGED":
        # Funds sit in the settlement wallet; process_staged() finishes it whatever the price does.
        row.status = "SETTLING"
        row.settlement = json.dumps({"resume": result.get("settlement"), "error": result.get("error")})
    elif status in ("NEEDS_REPROOF", "NO_ROUTE"):
        # Nothing was sent. NEEDS_REPROOF waits for the browser to attach a fresh proof
        # (/executeStrategy refresh_only); NO_ROUTE simply tries again when it next fires.
        row.status = "PENDING" if status == "NEEDS_REPROOF" else "ARMED"
        row.settlement = json.dumps({"waiting": status, "error": result.get("error")})
    else:
        row.status = "FAILED"
        row.settlement = json.dumps({"error": result.get("error")})
    if not is_leg and status != "EXECUTED":
        row.execution_error = f"{status}: {result.get('error') or ''}"[:500]
    db.session.commit()


def _stored_resume(row) -> Optional[dict]:
    try:
        return (json.loads(row.settlement or "{}") or {}).get("resume")
    except (TypeError, ValueError):
        return None


def settle_strategy_row(sid: str) -> dict[str, Any]:
    """Settle a claimed single Devnet order and record the outcome on its row."""
    from database import Strategy

    row = Strategy.query.get(sid)
    if row is None:
        return {"ok": False, "status": "FAILED", "error": "strategy not found"}
    d = row.to_dict()
    waiting = (d.get("settlement") or {}).get("waiting")
    if waiting == "NEEDS_REPROOF":
        # Same stale proof as last time: running it again cannot succeed. /executeStrategy with
        # refresh_only clears this when the browser attaches a fresh one.
        row.status = "PENDING"
        from database import db
        db.session.commit()
        return {"ok": False, "status": "NEEDS_REPROOF", "code": "NEEDS_REPROOF",
                "error": "waiting for a fresh proof from the browser"}
    try:
        result = settle(d, _zkp(d), _stored_resume(row))
    except Exception as exc:  # the lock and subprocess are the only things that can raise here
        logger.exception("Devnet settle failed")
        result = {"ok": False, "status": "FAILED", "error": str(exc)}
    _record(row, result, is_leg=False)
    return result


def _pipeline_pkg_ready(zkp: dict) -> bool:
    """True when a pipeline hop package carries a full Groth16 spend (not a venue skeleton)."""
    publics = zkp.get("publics")
    return isinstance(publics, list) and len(publics) == 25 and bool(zkp.get("proof_hex"))


def settle_leg_row(leg_id: str, strategy_dict: dict) -> dict[str, Any]:
    """Settle one claimed leg of a Devnet multi-leg order (its own slice note and return note)."""
    from database import StrategyLeg

    leg = StrategyLeg.query.get(leg_id)
    if leg is None:
        return {"ok": False, "status": "FAILED", "error": "leg not found"}
    try:
        waiting = (json.loads(leg.settlement or "{}") or {}).get("waiting")
    except (TypeError, ValueError):
        waiting = None
    is_pipe = (leg.leg_kind or "").lower() == "pipeline"
    hop_i = int(leg.leg_index or 0)
    if waiting == "NEEDS_REPROOF":
        # Pipeline hops 1..N: TEE re-proves with fresh leaves (no browser). Hop 0 waits on browser.
        if is_pipe and hop_i > 0:
            reproved = _reprove_pipeline_leg(leg, strategy_dict)
            if not reproved.get("ok"):
                return reproved
            zkp = _zkp({"zkp_data": leg.zkp_data})
        else:
            from database import db
            leg.status = "PENDING"
            db.session.commit()
            return {"ok": False, "status": "NEEDS_REPROOF", "code": "NEEDS_REPROOF",
                    "error": "waiting for a fresh proof from the browser"}
    else:
        zkp = _zkp({"zkp_data": leg.zkp_data})
    # Never settle a pipeline hop 1..N venue skeleton — that yields "publics must be 25 limbs"
    # after hop 0 already moved funds into a TEE-held return note.
    if is_pipe and hop_i > 0 and not _pipeline_pkg_ready(zkp):
        reproved = _reprove_pipeline_leg(leg, strategy_dict)
        if not reproved.get("ok"):
            return reproved
        zkp = _zkp({"zkp_data": leg.zkp_data})
        if not _pipeline_pkg_ready(zkp):
            return {"ok": False, "status": "FAILED",
                    "error": "pipeline hop has no Groth16 package (publics must be 25 limbs)"}
    try:
        result = settle(strategy_dict, zkp, _stored_resume(leg))
    except Exception as exc:
        logger.exception("Devnet leg settle failed")
        result = {"ok": False, "status": "FAILED", "error": str(exc)}
    _record(leg, result, is_leg=True)
    if result.get("status") == "EXECUTED" and is_pipe:
        try:
            advance_pipeline(strategy_dict.get("id") or leg.strategy_id)
        except Exception:
            logger.exception("pipeline advance after leg %s failed", leg_id)
    return result


def _reprove_pipeline_leg(leg, strategy_dict: dict) -> dict[str, Any]:
    """TEE retry for a pipeline hop waiting on NEEDS_REPROOF (fresh leaves, same sealed secrets)."""
    from database import Strategy, StrategyLeg, db
    import pipeline_tee

    parent = Strategy.query.get(leg.strategy_id) or strategy_dict
    parent_d = parent.to_dict() if hasattr(parent, "to_dict") else dict(strategy_dict)
    sealed = pipeline_tee.sealed_bundle_of(parent_d)
    if not sealed:
        return {"ok": False, "status": "FAILED", "error": "pipeline sealed_bundle missing"}
    prev = StrategyLeg.query.filter_by(
        strategy_id=leg.strategy_id, leg_index=int(leg.leg_index) - 1
    ).first()
    if prev is None:
        return {"ok": False, "status": "FAILED", "error": "previous pipeline hop missing"}
    try:
        prev_settle = json.loads(prev.settlement or "{}") or {}
    except (TypeError, ValueError):
        prev_settle = {}
    note = prev_settle.get("returned_note")
    if not note:
        return {"ok": False, "status": "FAILED", "error": "previous hop has no returned_note"}
    venue = _zkp({"zkp_data": leg.zkp_data})
    try:
        settle_pk = settlement_pubkey()
    except Exception as exc:
        return {"ok": False, "status": "FAILED", "error": str(exc)}
    proved = pipeline_tee.prove_pipeline_hop(
        str(leg.strategy_id),
        int(leg.leg_index),
        sealed_bundle=sealed,
        public_context={
            "returned_note": note,
            "settlement": settle_pk,
            "venue": venue,
            "input_hop_index": int(leg.leg_index) - 1,
            "return_hop_index": int(leg.leg_index),
        },
    )
    if not proved.get("ok"):
        code = proved.get("code") or "NEEDS_REPROOF"
        leg.settlement = json.dumps({"waiting": code, "error": proved.get("error")})
        db.session.commit()
        return {"ok": False, "status": code, "code": code, "error": proved.get("error")}
    pkg = proved["package"]
    leg.zkp_data = json.dumps(pkg)
    leg.settlement = None
    leg.status = "EXECUTING"
    db.session.commit()
    return {"ok": True}


def advance_pipeline(strategy_id: str) -> dict[str, Any]:
    """After hop N EXECUTED + returned_note: TEE-prove hop N+1 and settle it."""
    from database import Strategy, StrategyLeg, db
    import pipeline_tee

    parent = Strategy.query.get(strategy_id)
    if parent is None:
        return {"ok": False, "error": "strategy not found"}
    parent_d = parent.to_dict()
    if not pipeline_tee.is_pipeline_strategy(parent_d):
        return {"ok": False, "error": "not a pipeline"}
    sealed = pipeline_tee.sealed_bundle_of(parent_d)
    if not sealed:
        return {"ok": False, "error": "sealed_bundle missing"}

    done = (
        StrategyLeg.query.filter_by(strategy_id=strategy_id, status="EXECUTED")
        .order_by(StrategyLeg.leg_index.desc())
        .first()
    )
    if done is None:
        return {"ok": False, "error": "no executed hop"}
    next_i = int(done.leg_index) + 1
    nxt = StrategyLeg.query.filter_by(strategy_id=strategy_id, leg_index=next_i).first()
    if nxt is None:
        # Last hop done — mark parent EXECUTED here so execute_now pipelines don't wait on the scheduler.
        meta = pipeline_tee.parent_pipeline_meta(parent.zkp_data)
        meta["hop_cursor"] = int(done.leg_index)
        parent.zkp_data = json.dumps(meta)
        parent.executed_count = StrategyLeg.query.filter_by(
            strategy_id=strategy_id, status="EXECUTED"
        ).count()
        remaining = StrategyLeg.query.filter(
            StrategyLeg.strategy_id == strategy_id,
            StrategyLeg.status.in_(["PENDING", "ARMED", "EXECUTING", "SETTLING", "QUEUED"]),
        ).count()
        if remaining == 0 and parent.status not in ("EXECUTED", "FAILED"):
            parent.status = "EXECUTED"
            parent.tx_hash = done.tx_hash or parent.tx_hash
        db.session.commit()
        return {"ok": True, "done": True, "hop_cursor": int(done.leg_index)}

    try:
        settle_rec = json.loads(done.settlement or "{}") or {}
    except (TypeError, ValueError):
        settle_rec = {}
    note = settle_rec.get("returned_note")
    if not note:
        return {"ok": False, "error": "executed hop missing returned_note"}

    venue = _zkp({"zkp_data": nxt.zkp_data})
    try:
        settle_pk = settlement_pubkey()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    # Cursor first (UI progress). Do NOT mark EXECUTING until a full package exists — settling
    # the venue skeleton produces "publics must be 25 limbs" after hop 0 already moved funds.
    meta = pipeline_tee.parent_pipeline_meta(parent.zkp_data)
    meta["hop_cursor"] = next_i
    parent.zkp_data = json.dumps(meta)
    db.session.commit()

    proved = pipeline_tee.prove_pipeline_hop(
        str(strategy_id),
        next_i,
        sealed_bundle=sealed,
        public_context={
            "returned_note": note,
            "settlement": settle_pk,
            "venue": venue,
            "input_hop_index": next_i - 1,
            "return_hop_index": next_i,
        },
    )
    if not proved.get("ok"):
        code = proved.get("code") or "FAILED"
        # NO_ROUTE / NEEDS_REPROOF: keep cursor visible; backoff via ARMED/PENDING.
        nxt.status = "ARMED" if code == "NO_ROUTE" else ("PENDING" if code == "NEEDS_REPROOF" else "FAILED")
        nxt.settlement = json.dumps({"waiting": code, "error": proved.get("error"), "hop_cursor": next_i})
        if code == "FAILED":
            parent.status = "FAILED"
            parent.execution_error = f"pipeline hop {next_i}: {proved.get('error') or ''}"[:500]
        db.session.commit()
        return {"ok": False, "status": code, "error": proved.get("error"), "hop_cursor": next_i}

    pkg = proved.get("package") or {}
    if not _pipeline_pkg_ready(pkg if isinstance(pkg, dict) else {}):
        nxt.status = "FAILED"
        err = "pipeline prove returned a package without 25 public limbs"
        nxt.settlement = json.dumps({"waiting": "FAILED", "error": err, "hop_cursor": next_i})
        parent.status = "FAILED"
        parent.execution_error = f"pipeline hop {next_i}: {err}"[:500]
        db.session.commit()
        return {"ok": False, "status": "FAILED", "error": err, "hop_cursor": next_i}

    nxt.zkp_data = json.dumps(pkg)
    nxt.settlement = None
    nxt.status = "EXECUTING"
    db.session.commit()
    result = settle_leg_row(nxt.id, parent.to_dict())
    return {**result, "hop_cursor": next_i}


def process_staged() -> None:
    """Finish settlements whose spend landed but whose swap or return did not. Runs every
    scheduler tick, independent of the trigger: the funds already left the vault."""
    from database import Strategy, StrategyLeg

    for row in Strategy.query.filter_by(status="SETTLING", from_chain=str(SOLANA_DEVNET_CHAIN_ID)).all():
        _record(row, settle(row.to_dict(), _zkp(row.to_dict()), _stored_resume(row)), is_leg=False)
    for leg in StrategyLeg.query.filter_by(status="SETTLING").all():
        parent = leg.strategy
        if parent is None or str(parent.from_chain) != str(SOLANA_DEVNET_CHAIN_ID):
            continue
        _record(leg, settle(parent.to_dict(), _zkp({"zkp_data": leg.zkp_data}), _stored_resume(leg)),
                is_leg=True)


def process_pipeline_advances() -> None:
    """Resume PIPELINE after hop N EXECUTED when hop N+1 never left QUEUED.

    advance_pipeline is only invoked inline after settle; if TEE unseal/prove throws
    (e.g. decryptor 404), the exception is logged and the next hop stays QUEUED forever
    unless we retry here.
    """
    from database import Strategy, StrategyLeg
    import pipeline_tee

    # from_chain may be stored as int or str depending on arm path — compare loosely.
    chain = str(SOLANA_DEVNET_CHAIN_ID)
    parents = Strategy.query.filter(
        Strategy.strategy_type == "PIPELINE",
        Strategy.status.in_(("ARMED", "PENDING", "EXECUTING", "SETTLING", "EXECUTED")),
    ).all()
    for parent in parents:
        if str(parent.from_chain or "") != chain:
            continue
        # Parent can show EXECUTED from hop-0 auto-execute while later hops are still QUEUED.
        parent_d = parent.to_dict()
        if not pipeline_tee.is_pipeline_strategy(parent_d):
            continue
        done = (
            StrategyLeg.query.filter_by(strategy_id=parent.id, status="EXECUTED")
            .order_by(StrategyLeg.leg_index.desc())
            .first()
        )
        if done is None:
            continue
        nxt = StrategyLeg.query.filter_by(
            strategy_id=parent.id, leg_index=int(done.leg_index) + 1
        ).first()
        if nxt is not None and (nxt.status or "").upper() not in (
            "QUEUED",
            "PENDING",
            "ARMED",
        ):
            continue
        if nxt is None and (parent.status or "").upper() == "EXECUTED":
            continue  # truly finished
        try:
            print(
                f"[Scheduler] pipeline resume advance strategy={parent.id} "
                f"after hop {done.leg_index} (parent={parent.status})"
            )
            out = advance_pipeline(parent.id)
            if isinstance(out, dict) and not out.get("ok"):
                err = str(out.get("error") or "")
                if _pipeline_unseal_fatal(err):
                    _fail_pipeline_mid_hop(parent, nxt, err)
        except Exception as exc:
            err = str(exc)
            logger.exception("pipeline resume advance failed strategy=%s", parent.id)
            print(f"[Scheduler] pipeline resume advance failed strategy={parent.id}: {err}")
            if _pipeline_unseal_fatal(err):
                _fail_pipeline_mid_hop(parent, nxt, err)


def _pipeline_unseal_fatal(err: str) -> bool:
    """Decryptor key rotation / missing prove deps — retrying burns logs and cannot recover."""
    low = (err or "").lower()
    return any(
        s in low
        for s in (
            "different enclave boot",
            "did not unseal",
            "unseal-hop http 404",
            "unseal-hop http 5",
            "pipeline-prove http 500",
            "pipeline-prove http 404",
            "non-json",
            "expecting value",
            "binfileutils",
        )
    )


def _fail_pipeline_mid_hop(parent, nxt, err: str) -> None:
    """Stop scheduler thrash: hop 0 already moved funds; later hops cannot be TEE-proved."""
    from database import db

    msg = f"pipeline stuck after hop 0: {err}"[:500]
    if nxt is not None and (nxt.status or "").upper() in ("QUEUED", "PENDING", "ARMED"):
        nxt.status = "FAILED"
        nxt.settlement = json.dumps({"waiting": "FAILED", "error": msg})
    if (parent.status or "").upper() not in ("FAILED", "CANCELLED", "EXPIRED"):
        parent.status = "FAILED"
        parent.execution_error = msg
    try:
        db.session.commit()
        print(f"[Scheduler] pipeline {parent.id} marked FAILED (fatal unseal/prove): {msg}")
    except Exception:
        db.session.rollback()
        logger.exception("failed to mark pipeline %s FAILED", parent.id)


def run_solana_devnet_strategy(strategy: dict) -> dict[str, Any]:
    """Executor entry for from_chain=900002 (claimed by the caller)."""
    return settle_strategy_row(strategy["id"])

"""MPC-shaped pipeline TEE facade: unseal hop secrets + prove next hop spend package.

sealPipelineBundle lives in the browser (attestAndSeal). provePipelineHop is this module +
decryptor /pipeline/unseal-hop + the app's /api/solana/pipeline-prove (snarkjs). A future MPC
prover swaps the prove implementation only.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

DECRYPTOR_URL = (os.getenv("DECRYPTOR_URL") or "").rstrip("/")
DECRYPTOR_AUTH_TOKEN = os.getenv("DECRYPTOR_AUTH_TOKEN", "")
DECRYPTOR_TIMEOUT = int(os.getenv("DECRYPTOR_TIMEOUT", "60"))
PIPELINE_PROVE_URL = (
    os.getenv("PIPELINE_PROVE_URL")
    or os.getenv("SIPHON_PIPELINE_PROVE_URL")
    or ""
).rstrip("/")
PIPELINE_PROVE_TOKEN = (
    os.getenv("PIPELINE_PROVE_TOKEN") or os.getenv("SOLANA_PIPELINE_PROVE_TOKEN") or ""
).strip()
PROVE_TIMEOUT = int(os.getenv("PIPELINE_PROVE_TIMEOUT", "300"))


def _auth_headers() -> dict:
    return {"X-Decryptor-Token": DECRYPTOR_AUTH_TOKEN} if DECRYPTOR_AUTH_TOKEN else {}


def unseal_pipeline_hop(sealed_bundle: str, hop_index: int) -> dict[str, Any]:
    """Ask the decryptor for one hop's note secrets. Never logs the plaintext."""
    if not DECRYPTOR_URL:
        raise RuntimeError("DECRYPTOR_URL required to unseal pipeline hop secrets")
    r = requests.post(
        f"{DECRYPTOR_URL}/pipeline/unseal-hop",
        json={"sealedBundle": sealed_bundle, "hopIndex": hop_index},
        headers=_auth_headers(),
        timeout=DECRYPTOR_TIMEOUT,
    )
    body = r.json() if r.content else {}
    if not r.ok or not body.get("ok"):
        raise RuntimeError(body.get("error") or f"unseal-hop HTTP {r.status_code}")
    hop = body.get("hop") or {}
    # Decryptor returns camelCase; normalise for the prove route.
    return {
        "nullifier": str(hop.get("nullifier") or ""),
        "secret": str(hop.get("secret") or ""),
        "userSalt": str(hop.get("userSalt") or hop.get("user_salt") or ""),
        "precommitment": str(hop.get("precommitment") or ""),
    }


def prove_pipeline_hop(
    strategy_id: str,
    hop_index: int,
    *,
    sealed_bundle: str,
    public_context: dict[str, Any],
) -> dict[str, Any]:
    """Unseal input + return hop secrets, prove the spend, return a venue package.

    public_context keys:
      returned_note, settlement, venue, input_hop_index, return_hop_index
    """
    input_i = int(public_context.get("input_hop_index", hop_index - 1))
    return_i = int(public_context.get("return_hop_index", hop_index))
    if input_i < 0:
        raise RuntimeError("pipeline hop 0 is proved in the browser, not the TEE")

    input_hop = unseal_pipeline_hop(sealed_bundle, input_i)
    return_hop = unseal_pipeline_hop(sealed_bundle, return_i)

    prove_url = PIPELINE_PROVE_URL
    if not prove_url:
        # Same-origin Next app default for local mock TEE.
        prove_url = (os.getenv("SIPHON_APP_URL") or os.getenv("NEXT_PUBLIC_APP_URL") or "").rstrip("/")
    if not prove_url:
        raise RuntimeError("PIPELINE_PROVE_URL (or SIPHON_APP_URL) required for pipeline prove")

    headers = {
        "Content-Type": "application/json",
        # Avoid the app's crawler middleware treating python-requests as a bot.
        "User-Agent": "siphon-pipeline-tee/1.0",
    }
    if PIPELINE_PROVE_TOKEN:
        headers["X-Pipeline-Prove-Token"] = PIPELINE_PROVE_TOKEN

    payload = {
        "input_hop": input_hop,
        "return_hop": return_hop,
        "returned_note": public_context["returned_note"],
        "settlement": public_context["settlement"],
        "venue": public_context.get("venue") or {},
    }
    r = requests.post(
        f"{prove_url}/api/solana/pipeline-prove",
        json=payload,
        headers=headers,
        timeout=PROVE_TIMEOUT,
    )
    try:
        body = r.json() if r.content else {}
    except ValueError:
        snippet = (r.text or "")[:180].replace("\n", " ")
        return {
            "ok": False,
            "status": "FAILED",
            "code": "FAILED",
            "error": f"pipeline-prove HTTP {r.status_code} non-JSON: {snippet}",
        }
    if not isinstance(body, dict):
        body = {}
    if not r.ok or not body.get("ok"):
        code = body.get("code") or "FAILED"
        err = body.get("error") or f"pipeline-prove HTTP {r.status_code}"
        return {"ok": False, "status": code, "code": code, "error": err}
    pkg = body.get("package")
    if not isinstance(pkg, dict):
        return {"ok": False, "status": "FAILED", "error": "pipeline-prove returned no package"}
    logger.info("pipeline prove ok strategy=%s hop=%s", strategy_id, hop_index)
    return {"ok": True, "package": pkg}


def parent_pipeline_meta(zkp_data: Any) -> dict[str, Any]:
    if isinstance(zkp_data, str):
        try:
            zkp_data = json.loads(zkp_data)
        except Exception:
            return {}
    return zkp_data if isinstance(zkp_data, dict) else {}


def is_pipeline_strategy(strategy_dict: dict) -> bool:
    if str(strategy_dict.get("strategy_type") or "").upper() == "PIPELINE":
        return True
    meta = parent_pipeline_meta(strategy_dict.get("zkp_data"))
    return bool(meta.get("pipeline"))


def sealed_bundle_of(strategy_dict: dict) -> Optional[str]:
    meta = parent_pipeline_meta(strategy_dict.get("zkp_data"))
    sealed = meta.get("sealed_bundle") or meta.get("pipeline_sealed")
    return str(sealed) if sealed else None

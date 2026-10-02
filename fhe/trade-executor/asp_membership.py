"""Hard ASP membership check for FHE arm / settle paths."""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

import requests

log = logging.getLogger("asp.membership")

_ASP_URL = (os.getenv("ASP_URL") or os.getenv("ASP_HTTP_URL") or "").rstrip("/")
_ASP_TOKEN = (os.getenv("ASP_SCREEN_TOKEN") or "").strip()
_env_name = (os.getenv("SIPHON_ENV") or os.getenv("ASP_ENV") or "").strip().lower()
_prod = _env_name in ("production", "prod", "mainnet")
# Fail-open is a local/test break-glass only. Production always fails closed even if a stale
# deployment accidentally retains ASP_ALLOW_LABEL_FAIL_OPEN=1.
_allow_fail_open_requested = os.getenv("ASP_ALLOW_LABEL_FAIL_OPEN", "").lower() in (
    "1",
    "true",
    "yes",
)
_ALLOW_FAIL_OPEN = _allow_fail_open_requested and not _prod
_FAIL_CLOSED = not _ALLOW_FAIL_OPEN
# Require ASP HTTP root == Entrypoint.currentAspRoot before arming (HA-P6 residual).
# Default ON in production; override with ASP_REQUIRE_ONCHAIN_ROOT=0 for local soak.
_req_root = os.getenv("ASP_REQUIRE_ONCHAIN_ROOT", "1" if _prod else "").strip().lower()
_REQUIRE_ONCHAIN_ROOT = _req_root in ("1", "true", "yes") or (_prod and _req_root not in ("0", "false", "no"))

_ROOT_ABI = [
    {
        "inputs": [],
        "name": "currentAspRoot",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    }
]


def _asp_v2() -> tuple[str, str]:
    """(base_url, screen_token) for the v2 ASP. Read per call so a redeploy needs no code change."""
    base = (os.getenv("ASP_V2_URL") or "").rstrip("/")
    token = (os.getenv("ASP_V2_SCREEN_TOKEN") or "").strip()
    return base, token


def _is_v3_chain(chain_id: int | str | None) -> bool:
    """True where the chain runs the v3 VaultKernel — the same discriminator the executor uses to
    pick the attested execution path (`executor_runner._is_attested_strategy`)."""
    if chain_id is None:
        return False
    try:
        from evm_chain_config import get_evm_chain_config

        return bool(get_evm_chain_config(chain_id).vault_kernel)
    except Exception:
        return False


def _assert_label_in_asp_v3(label: str, *, timeout: float) -> tuple[bool, str]:
    """v3 admission: the label must be admitted, and not revoked, in the v2 ASP.

    Two deliberate differences from the v1 gate below.

    The set lives in the v2 ASP, which is a different service with a different database and its own
    screen token — asking the v1 ASP about a v3 label returns "not a member" for every label ever
    minted, which is what surfaced as a blanket "ASP label rejected" on v3 arms.

    There is no root-equality check. On v3 the admitted/revoked roots are proof PUBLIC INPUTS that
    the enclave binds at FIRE time and `ComplianceHub.verifyFreshness` re-checks on chain, so an
    arm-time root is stale by construction — proving late is the whole reason v3 exists. Requiring
    equality here would also refuse every arm for the length of each 5-minute admit bus, and buy
    nothing the spend does not already enforce.
    """
    base, token = _asp_v2()
    if not base:
        if _FAIL_CLOSED:
            return False, "ASP_V2_URL not configured (fail-closed)"
        log.warning("ASP_V2_URL unset — skipping v3 label membership (fail-open)")
        return True, "asp_v2_unconfigured_fail_open"

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        r = requests.get(
            f"{base}/set/member",
            params={"label": label},
            headers=headers,
            timeout=timeout,
        )
        if r.status_code != 200:
            msg = f"ASP v2 /set/member HTTP {r.status_code}"
            return (False, msg) if _FAIL_CLOSED else (True, msg + " fail-open")
        data = r.json()
    except Exception as e:
        msg = f"ASP v2 membership check failed: {e}"
        log.warning(msg)
        return (False, msg) if _FAIL_CLOSED else (True, msg + " fail-open")

    if data.get("revoked") is True:
        return False, "label revoked"
    if data.get("admitted") is not True:
        return False, "label not admitted yet (the deposit may still be in the admit bus)"
    return True, "admitted"


def _onchain_asp_root(chain_id: int | str | None) -> Optional[str]:
    """Read Entrypoint.currentAspRoot for the strategy source chain.

    Retried once: the gate is fail-closed, so a single transient RPC response turns into a
    user-facing "ASP label rejected" on a label that is perfectly valid. Observed in practice —
    one `execution reverted` on an eth_call that then succeeded 12/12 on the same address.
    """
    if chain_id is None:
        return None

    last_err: Exception | None = None
    for attempt in (1, 2):
        try:
            from web3 import Web3
            from evm_chain_config import get_evm_chain_config

            chain = get_evm_chain_config(chain_id)
            if not chain.entrypoint:
                return None
            w3 = Web3(Web3.HTTPProvider(chain.rpc_url, request_kwargs={"timeout": 12}))
            ep = w3.eth.contract(
                address=Web3.to_checksum_address(chain.entrypoint),
                abi=_ROOT_ABI,
            )
            return str(int(ep.functions.currentAspRoot().call()))
        except Exception as e:
            last_err = e
            if attempt == 1:
                log.warning(
                    "currentAspRoot read failed (chain=%s, entrypoint=%s): %s — retrying",
                    chain_id, locals().get("chain").entrypoint if locals().get("chain") else "?", e,
                )
                time.sleep(0.75)

    log.warning("currentAspRoot read failed twice (chain=%s): %s", chain_id, last_err)
    return None


def _asp_http_root(*, timeout: float = 15.0) -> Optional[str]:
    if not _ASP_URL:
        return None
    headers = {}
    if _ASP_TOKEN:
        headers["Authorization"] = f"Bearer {_ASP_TOKEN}"
    try:
        r = requests.get(f"{_ASP_URL}/set/root", headers=headers, timeout=timeout)
        if r.status_code != 200:
            return None
        root = r.json().get("root")
        return str(root) if root is not None else None
    except Exception as e:
        log.warning("ASP /set/root failed: %s", e)
        return None


def assert_label_in_asp(
    label: str | int,
    *,
    chain_id: int | str | None = None,
    timeout: float = 15.0,
) -> tuple[bool, str]:
    """
    Return (ok, reason). ok=True means label is in the live association set.
    When ASP_URL is unset: fail closed unless ASP_ALLOW_LABEL_FAIL_OPEN=1.
    When ASP_REQUIRE_ONCHAIN_ROOT: also require HTTP root == on-chain currentAspRoot.

    A v3 chain routes to `_assert_label_in_asp_v3` instead: different ASP, different root model.
    """
    lab = str(label).strip()
    if not lab:
        return False, "label required"

    if _is_v3_chain(chain_id):
        return _assert_label_in_asp_v3(lab, timeout=timeout)

    if not _ASP_URL:
        if _FAIL_CLOSED:
            return False, "ASP_URL not configured (fail-closed)"
        log.warning("ASP_URL unset — skipping label membership (fail-open via ASP_ALLOW_LABEL_FAIL_OPEN)")
        return True, "asp_unconfigured_fail_open"

    headers = {}
    if _ASP_TOKEN:
        headers["Authorization"] = f"Bearer {_ASP_TOKEN}"

    try:
        r = requests.get(
            f"{_ASP_URL}/set/member",
            params={"label": lab},
            headers=headers,
            timeout=timeout,
        )
        if r.status_code != 200:
            msg = f"ASP /set/member HTTP {r.status_code}"
            return (False, msg) if _FAIL_CLOSED else (True, msg + " fail-open")
        data = r.json()
        if data.get("member") is not True:
            return False, "label not in association set"
    except Exception as e:
        msg = f"ASP membership check failed: {e}"
        log.warning(msg)
        return (False, msg) if _FAIL_CLOSED else (True, msg + " fail-open")

    if _REQUIRE_ONCHAIN_ROOT and chain_id is not None:
        http_root = _asp_http_root(timeout=timeout)
        chain_root = _onchain_asp_root(chain_id)
        if not http_root or not chain_root:
            msg = "ASP root / on-chain currentAspRoot unavailable"
            return (False, msg) if _FAIL_CLOSED else (True, msg + " fail-open")
        if str(http_root) != str(chain_root):
            return False, (
                f"ASP HTTP root != Entrypoint.currentAspRoot "
                f"(off-chain set lag — run postman publish)"
            )

    return True, "member"

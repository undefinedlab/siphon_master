"""zkMe KYT Layer-2 screening client — no response cache (deposit-time live call)."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

import requests

import config
from solana_chain_ids import is_solana_chain_id

log = logging.getLogger("aspv2.zkme")

_ZKME_BASE = "https://agw.zk.me/zkseradmin/openapi/kyt"
_ZKME_RISK_ENDPOINT = f"{_ZKME_BASE}/risk/score"
_ZKME_STATUS_ENDPOINT = f"{_ZKME_BASE}/status"
_REQUEST_TIMEOUT = 10

# Cloudflare on agw.zk.me rejects the default Python requests user-agent (HTTP 1010).
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Origin": "https://dashboard.zk.me",
    "Referer": "https://dashboard.zk.me/",
}

# Coin labels from GET /kyt/status supportCoin — chain-specific graphs, not all "ETH".
_CHAIN_TO_COIN: dict[int, str] = {
    1: "ETH",
    8453: "ETH-Base",
    11155111: "ETH",
    42161: "ETH-Arbitrum",
    10: "ETH-Optimism",
    137: "MATIC-Polygon",
    43114: "AVAX-Avalanche",
    56: "BNB",
    # Siphon-assigned Solana ids (see solana_chain_ids.py / SOLANA-CHAIN-IDS.md).
    900001: "SOL",
    900002: "SOL",
}

_SUCCESS_CODES = frozenset({200, 80000000, "200", "80000000", 0})


class ZkMeUnavailable(Exception):
    pass


@dataclass
class ZkMeResult:
    decision: str
    risk_score: int
    risk_level: str
    reasons: list[str] = field(default_factory=list)
    raw: dict = field(default_factory=dict)


@dataclass
class ZkMeApiStatus:
    support_api: list[str]
    support_coin: list[str]
    raw: dict = field(default_factory=dict)


def _auth_payload() -> dict[str, str]:
    if not config.ZKME_MCH_NO or not config.ZKME_API_KEY:
        raise ZkMeUnavailable("ZKME_MCH_NO / ZKME_API_KEY not configured")
    return {"apiKey": config.ZKME_API_KEY, "mchNo": config.ZKME_MCH_NO}


def _post(endpoint: str, extra: dict | None = None) -> dict:
    payload = _auth_payload()
    if extra:
        payload.update(extra)
    try:
        resp = requests.post(
            endpoint,
            json=payload,
            headers=_HEADERS,
            timeout=_REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        body = resp.json()
    except requests.RequestException as exc:
        raise ZkMeUnavailable(f"zkMe API error: {exc}") from exc
    except ValueError as exc:
        raise ZkMeUnavailable("zkMe API returned non-JSON") from exc

    if not isinstance(body, dict):
        raise ZkMeUnavailable("zkMe API returned unexpected payload")

    code = body.get("code")
    if code not in _SUCCESS_CODES and body.get("success") is not True:
        msg = body.get("message") or body.get("msg") or f"code {code}"
        raise ZkMeUnavailable(f"zkMe API rejected: {msg}")

    data = body.get("data")
    if isinstance(data, dict):
        return data
    return body


def get_api_status() -> ZkMeApiStatus:
    """Call GET /kyt/status — lists enabled APIs and supported coin graphs."""
    data = _post(_ZKME_STATUS_ENDPOINT)
    apis = data.get("support_api") or data.get("supportApi") or []
    coins = data.get("support_coin") or data.get("supportCoin") or []
    return ZkMeApiStatus(
        support_api=[str(x) for x in apis],
        support_coin=[str(x) for x in coins],
        raw=data,
    )


def _parse_risk(data: dict) -> ZkMeResult:
    score = int(data.get("score") or data.get("riskScore") or 0)
    level = str(data.get("risk_level") or data.get("riskLevel") or "").capitalize()
    detail_list: list = data.get("detail_list") or data.get("detailList") or []
    reasons: list[str] = []
    for item in detail_list:
        if isinstance(item, str):
            reasons.append(item)
        elif isinstance(item, dict) and item.get("label"):
            reasons.append(str(item["label"]))

    deny = score >= config.ZKME_RISK_THRESHOLD or level in ("High", "Severe")
    decision = "deny" if deny else "admit"
    return ZkMeResult(
        decision=decision,
        risk_score=score,
        risk_level=level,
        reasons=[f"zkme_{r.lower().replace(' ', '_')}" for r in reasons] if deny else [],
        raw=data,
    )


def screen_address(address: str, chain_id: int) -> ZkMeResult:
    # Base58 public keys are case-sensitive. EVM addresses remain canonical lowercase.
    stripped = address.strip()
    addr = stripped if is_solana_chain_id(chain_id) else stripped.lower()
    coin = _CHAIN_TO_COIN.get(chain_id, "ETH")
    data = _post(
        _ZKME_RISK_ENDPOINT,
        {
            "coin": coin,
            "address": addr,
        },
    )
    result = _parse_risk(data)
    log.info(
        "zkme_screen address=%s chain_id=%s coin=%s score=%s level=%s decision=%s",
        addr,
        chain_id,
        coin,
        result.risk_score,
        result.risk_level,
        result.decision,
    )
    return result


def is_configured() -> bool:
    return bool(config.ZKME_MCH_NO and config.ZKME_API_KEY)

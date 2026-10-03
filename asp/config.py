"""siphon-aspv2 configuration — zkv2 / ComplianceHub aligned (no hop graph)."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent
MONOREPO = ROOT.parent
ZKV2_FIXTURES = MONOREPO / "siphon-zkv2" / "test-vectors"
# core/domains.py reads domains.json at RUNTIME, not just in tests, so a container with no
# sibling checkout crashed every admit on FileNotFoundError. Prefer a vendored copy and keep the
# sibling path as the fallback so a monorepo checkout still tracks zkv2 directly.
# Tests keep using ZKV2_FIXTURES: they read many cross-repo vectors and only run from a checkout.
ZKV2_DOMAINS_PATH = ROOT / "data" / "zkv2" / "domains.json"
if not ZKV2_DOMAINS_PATH.exists():
    ZKV2_DOMAINS_PATH = ZKV2_FIXTURES / "domains.json"

POLICY_VERSION = os.getenv("ASP_POLICY_VERSION", "screened-v2.0")
SET_ID = "screened"
PROTOCOL_VERSION = "3.4"

DATABASE_URL = (
    os.getenv("ASP_DATABASE_URL") or os.getenv("DATABASE_URL") or ""
).strip()
_DEFAULT_DATABASE_URL = "postgresql+psycopg2://asp:asp@127.0.0.1:5432/aspv2"
if not DATABASE_URL:
    # Product default is Postgres. Tests may set ASP_DATABASE_URL=sqlite:///:memory:
    DATABASE_URL = _DEFAULT_DATABASE_URL

# zkMe KYT (layer 2 — only after lists + oracle pass; billed ~$0.50/user/year)
ZKME_MCH_NO = (os.getenv("ZKME_MCH_NO") or "").strip()
ZKME_API_KEY = (os.getenv("ZKME_API_KEY") or "").strip()
ZKME_RISK_THRESHOLD = int(os.getenv("ZKME_RISK_THRESHOLD", "70"))

# Compliance fee → KYT entitlement (aligns with zkMe $0.50 / user / year)
COMPLIANCE_VAULT = (os.getenv("ASP_COMPLIANCE_VAULT") or "").strip().lower()


def compliance_vault(chain_id: int | None = None) -> str:
    """The address that receives the compliance fee on `chain_id`, lowercased.

    Per-chain, and this one is per-chain for a harsher reason than the postman key: the fee is a
    plain ETH transfer from the user, so a wrong address does not fail — it succeeds and the money
    is gone.

    The Sepolia vault is a contract with `withdraw`/`sweep`. That same address on Base holds NO
    code, because it was produced by CREATE from a deployer nonce that was never replayed there.
    Configured globally, every Base user's fee would land at an address with no contract and no
    key. It has already happened: 0.0006 ETH — exactly three fees at 0.0002 — is sitting at
    0x8fE01f5a6f9d62A846b91cE95814424F7cF5406D on Base right now.

    So a chain gets a vault only when one is named for it explicitly. The bare
    `ASP_COMPLIANCE_VAULT` remains the fallback for single-chain deployments, which is what every
    existing box is. Returning "" makes `/compliance-fee/check` report `vault: null` and the UI say
    the chain is not configured — the correct, loud answer.
    """
    if chain_id is not None:
        scoped = (os.getenv(f"ASP_COMPLIANCE_VAULT_{chain_id}") or "").strip().lower()
        if scoped:
            return scoped
        # A chain named in ASP_COMPLIANCE_VAULT_CHAINS opts OUT of the global fallback: it is
        # declaring that it needs its own address, so an unset one must stay empty rather than
        # silently inherit another chain's.
        if str(chain_id) in COMPLIANCE_VAULT_SCOPED_CHAINS:
            return ""
    return COMPLIANCE_VAULT


# Chains that must name their own vault and never inherit the global one. Base belongs here the
# moment it is live, so a leftover single-chain ASP_COMPLIANCE_VAULT cannot leak onto mainnet.
COMPLIANCE_VAULT_SCOPED_CHAINS = {
    c.strip()
    for c in (os.getenv("ASP_COMPLIANCE_VAULT_CHAINS") or "8453").split(",")
    if c.strip()
}
COMPLIANCE_FEE_WEI = int(
    os.getenv("ASP_COMPLIANCE_FEE_WEI", str(200_000_000_000_000))
)  # ~0.0002 ETH ≈ $0.50
COMPLIANCE_FEE_USDC = int(os.getenv("ASP_COMPLIANCE_FEE_USDC", "500000"))  # 0.50 USDC (6 dp)
KYT_ENTITLEMENT_DAYS = int(os.getenv("ASP_KYT_ENTITLEMENT_DAYS", "365"))
KYC_ENTITLEMENT_DAYS = int(os.getenv("ASP_KYC_ENTITLEMENT_DAYS", "365"))
# Dev escape: allow zkMe screen without paid entitlement (forbidden in production)
ALLOW_SKIP_KYT_FEE = os.getenv("ASP_ALLOW_SKIP_KYT_FEE", "").lower() in (
    "1",
    "true",
    "yes",
)
USDC_ADDRESS_BY_CHAIN: dict[int, str] = {
    1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
}

# Auth tokens
SCREEN_TOKEN = (os.getenv("ASP_SCREEN_TOKEN") or "").strip()
ADMIN_TOKEN = (os.getenv("ASP_ADMIN_TOKEN") or "").strip()
POSTMAN_TOKEN = (os.getenv("ASP_POSTMAN_TOKEN") or "").strip()
POSTMAN_ADDRESS = (os.getenv("ASP_POSTMAN_ADDRESS") or "").strip().lower()
AUTH_TOKEN_MIN_LEN = int(os.getenv("ASP_AUTH_TOKEN_MIN_LEN", "16"))

# F-5: identical tokens would collapse privilege boundaries
_tokens = [t for t in (SCREEN_TOKEN, ADMIN_TOKEN, POSTMAN_TOKEN) if t]
if len(_tokens) != len(set(_tokens)):
    raise RuntimeError(
        "ASP_SCREEN_TOKEN / ASP_ADMIN_TOKEN / ASP_POSTMAN_TOKEN must be distinct when set"
    )
# F-5: reject short tokens when configured
for _name, _tok in (
    ("ASP_SCREEN_TOKEN", SCREEN_TOKEN),
    ("ASP_ADMIN_TOKEN", ADMIN_TOKEN),
    ("ASP_POSTMAN_TOKEN", POSTMAN_TOKEN),
):
    if _tok and len(_tok) < AUTH_TOKEN_MIN_LEN:
        raise RuntimeError(f"{_name} must be at least {AUTH_TOKEN_MIN_LEN} characters")

# ComplianceHub per chain — accept both aspv2 and contracts-v2 env names:
#   ASP_COMPLIANCE_HUB_<chainId> | COMPLIANCE_HUB_<chainId> | ASP_COMPLIANCE_HUBS=8453:0x...
#   ASP_COMPLIANCE_HUB | COMPLIANCE_HUB | COMPLIANCE_HUB_ADDRESS
COMPLIANCE_HUB_BY_CHAIN: dict[int, str] = {}
for part in (os.getenv("ASP_COMPLIANCE_HUBS") or "").split(","):
    part = part.strip()
    if not part or ":" not in part:
        continue
    cid_s, addr = part.split(":", 1)
    try:
        COMPLIANCE_HUB_BY_CHAIN[int(cid_s)] = addr.strip()
    except ValueError:
        pass
for k, v in os.environ.items():
    if not v.strip():
        continue
    if k.startswith("ASP_COMPLIANCE_HUB_") and k != "ASP_COMPLIANCE_HUB":
        suffix = k[len("ASP_COMPLIANCE_HUB_") :]
        if suffix.isdigit():
            COMPLIANCE_HUB_BY_CHAIN[int(suffix)] = v.strip()
    elif k.startswith("COMPLIANCE_HUB_") and k not in (
        "COMPLIANCE_HUB",
        "COMPLIANCE_HUB_ADDRESS",
    ):
        suffix = k[len("COMPLIANCE_HUB_") :]
        if suffix.isdigit() and int(suffix) not in COMPLIANCE_HUB_BY_CHAIN:
            COMPLIANCE_HUB_BY_CHAIN[int(suffix)] = v.strip()


def postman_address(chain_id: int | None = None) -> str:
    """The pinned postman address for `chain_id`, lowercased.

    The companion to `postman_key`. Pinning against a single global address defeats the per-chain
    key: the Base postman would derive the Base address and then be rejected for not matching
    Sepolia's pin. Empty means no pin, which leaves only the on-chain check in
    `assert_postman_key_matches_chain`.
    """
    if chain_id is not None:
        scoped = (os.getenv(f"ASP_POSTMAN_ADDRESS_{chain_id}") or "").strip().lower()
        if scoped:
            return scoped
    return POSTMAN_ADDRESS


def postman_key(chain_id: int | None = None) -> str:
    """The postman signing key for `chain_id`.

    Per-chain because each ComplianceHub has its own postman address, and `chain_verify` asserts
    the key's address equals the on-chain postman for that chain. One scalar key therefore let a
    single ASP stack publish for exactly one chain — Base and Sepolia deliberately use different
    postman keys, so the mainnet key never sits on a box that also holds a testnet one.

    `ASP_POSTMAN_KEY_<chainId>` first, then the bare `ASP_POSTMAN_KEY`, mirroring
    `compliance_hub_address` — so a single-chain deployment needs no env change.
    """
    if chain_id is not None:
        scoped = (os.getenv(f"ASP_POSTMAN_KEY_{chain_id}") or "").strip()
        if scoped:
            return scoped
    return (os.getenv("ASP_POSTMAN_KEY") or "").strip()


def compliance_hub_address(chain_id: int | None = None) -> str:
    if chain_id is not None and chain_id in COMPLIANCE_HUB_BY_CHAIN:
        return COMPLIANCE_HUB_BY_CHAIN[chain_id]
    return (
        os.getenv("ASP_COMPLIANCE_HUB")
        or os.getenv("COMPLIANCE_HUB")
        or os.getenv("COMPLIANCE_HUB_ADDRESS")
        or ""
    ).strip()


# VaultKernel per chain: VAULT_KERNEL_<chainId> or VAULT_KERNELS=8453:0x...
VAULT_KERNEL_BY_CHAIN: dict[int, str] = {}
for part in (os.getenv("VAULT_KERNELS") or "").split(","):
    part = part.strip()
    if not part or ":" not in part:
        continue
    cid_s, addr = part.split(":", 1)
    try:
        VAULT_KERNEL_BY_CHAIN[int(cid_s)] = addr.strip()
    except ValueError:
        pass
for k, v in os.environ.items():
    if k.startswith("VAULT_KERNEL_") and k != "VAULT_KERNEL":
        suffix = k[len("VAULT_KERNEL_") :]
        if suffix.isdigit() and v.strip():
            VAULT_KERNEL_BY_CHAIN[int(suffix)] = v.strip()


def vault_kernel_address(chain_id: int | None = None) -> str:
    if chain_id is not None and chain_id in VAULT_KERNEL_BY_CHAIN:
        return VAULT_KERNEL_BY_CHAIN[chain_id]
    return (os.getenv("VAULT_KERNEL") or os.getenv("ASP_VAULT_KERNEL") or "").strip()


# RPC
RPC_URL = (os.getenv("ASP_RPC_URL") or "").strip()
RPC_URL_BY_CHAIN: dict[int, str] = {}
for part in (os.getenv("ASP_RPC_URLS") or "").split(","):
    part = part.strip()
    if not part or ":" not in part:
        continue
    cid_s, url = part.split(":", 1)
    try:
        RPC_URL_BY_CHAIN[int(cid_s)] = url.strip()
    except ValueError:
        pass


def rpc_url_for(chain_id: int) -> str | None:
    return RPC_URL_BY_CHAIN.get(chain_id) or (RPC_URL or None)


# List seeds — prefer local data/, fall back to siphon-asp vendored seeds
_V1_SEED = MONOREPO / "siphon-asp" / "data" / "seed"
SEED_MIXERS_PATH = ROOT / "data" / "seed" / "mixers_ofac_tornado.json"
if not SEED_MIXERS_PATH.exists():
    SEED_MIXERS_PATH = _V1_SEED / "mixers_ofac_tornado.json"
SEED_SANCTIONS_PATH = ROOT / "data" / "seed" / "sanctions_ofac_evm_snapshot.json"
if not SEED_SANCTIONS_PATH.exists():
    SEED_SANCTIONS_PATH = _V1_SEED / "sanctions_ofac_evm_snapshot.json"

# Production / degradation
_ENV_NAME = (os.getenv("ASP_ENV") or os.getenv("SIPHON_ENV") or "").strip().lower()
PRODUCTION_LOCK = _ENV_NAME in ("production", "prod", "mainnet")

# Refuse SQLite in production (multi-instance + advisory locks require Postgres).
if PRODUCTION_LOCK and DATABASE_URL.startswith("sqlite"):
    raise RuntimeError(
        "ASP_DATABASE_URL must be PostgreSQL in production (sqlite forbidden)"
    )
# F-4: reject default weak DSN in production
if PRODUCTION_LOCK and (
    DATABASE_URL == _DEFAULT_DATABASE_URL or "://asp:asp@" in DATABASE_URL
):
    raise RuntimeError(
        "default ASP_DATABASE_URL credentials (asp:asp) forbidden in production"
    )

_oracle_fc = os.getenv("ASP_ORACLE_FAIL_CLOSED", "1").strip().lower()
ORACLE_FAIL_CLOSED = _oracle_fc not in ("0", "false", "no")
if PRODUCTION_LOCK and not ORACLE_FAIL_CLOSED:
    raise RuntimeError("ASP_ORACLE_FAIL_CLOSED required in production")

REQUIRE_SEEDED_LISTS = os.getenv("ASP_REQUIRE_SEEDED_LISTS", "1").lower() not in ("0", "false", "no")
if PRODUCTION_LOCK and not REQUIRE_SEEDED_LISTS:
    raise RuntimeError("ASP_REQUIRE_SEEDED_LISTS required in production")
DEGRADED_AS_DENY = os.getenv("ASP_DEGRADED_AS_DENY", "").lower() in ("1", "true", "yes")
REQUIRE_AUTH = PRODUCTION_LOCK or (
    os.getenv("ASP_REQUIRE_AUTH", "1").lower() not in ("0", "false", "no")
)

SCREEN_RATE_LIMIT = int(os.getenv("ASP_SCREEN_RATE_LIMIT", "60"))
SCREEN_RATE_WINDOW_SEC = int(os.getenv("ASP_SCREEN_RATE_WINDOW_SEC", "60"))
SCREEN_BATCH_MAX = int(os.getenv("ASP_SCREEN_BATCH_MAX", "25"))
REDIS_URL = (os.getenv("ASP_REDIS_URL") or "").strip()
# F-6: multi-worker rate limits require Redis in production
if PRODUCTION_LOCK and not REDIS_URL:
    raise RuntimeError("ASP_REDIS_URL required in production (shared rate limits)")
FLASK_DEBUG = os.getenv("ASP_DEBUG", "").lower() in ("1", "true", "yes")
if PRODUCTION_LOCK and FLASK_DEBUG:
    raise RuntimeError("ASP_DEBUG forbidden in production")

OFAC_MAX_AGE_HOURS = int(os.getenv("ASP_OFAC_MAX_AGE_HOURS", "48"))
# F-2: screen admit decisions expire (seconds). Default 1h.
SCREEN_ADMIT_MAX_AGE_SEC = int(os.getenv("ASP_SCREEN_ADMIT_MAX_AGE_SEC", "3600"))
if PRODUCTION_LOCK and SCREEN_ADMIT_MAX_AGE_SEC <= 0:
    raise RuntimeError("ASP_SCREEN_ADMIT_MAX_AGE_SEC must be > 0 in production")
# Re-check oracle + local lists at admit/watcher binding time
SCREEN_ADMIT_RECHECK = os.getenv("ASP_SCREEN_ADMIT_RECHECK", "1").lower() not in (
    "0",
    "false",
    "no",
)
if PRODUCTION_LOCK and not SCREEN_ADMIT_RECHECK:
    raise RuntimeError("ASP_SCREEN_ADMIT_RECHECK required in production")
# F-4: cache TTLs — clean results short-lived; hits longer
ORACLE_CACHE_TTL_CLEAN_SEC = float(os.getenv("ASP_ORACLE_CACHE_TTL_CLEAN_SEC", "60"))
ORACLE_CACHE_TTL_HIT_SEC = float(os.getenv("ASP_ORACLE_CACHE_TTL_HIT_SEC", "3600"))

# Chainalysis OFAC oracle (mirrors siphon-app sanctionsScreen.ts)
ORACLE_DEFAULT = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb"
ORACLE_BY_CHAIN: dict[int, str] = {
    8453: "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B",
}
ORACLE_CHAINS = frozenset({1, 8453, 42161, 10, 137, 43114, 56, 250, 42220, 81457})
ORACLE_ABI = [
    {
        "inputs": [{"internalType": "address", "name": "addr", "type": "address"}],
        "name": "isSanctioned",
        "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    }
]

# ComplianceHub defaults (postman epoch publish)
ADMIT_EPOCH_SECONDS = int(os.getenv("ASP_ADMIT_EPOCH_SECONDS", "300"))
CHAIN_MIN_CONFIRMATIONS = int(
    os.getenv("ASP_CHAIN_MIN_CONFIRMATIONS", "2" if PRODUCTION_LOCK else "0")
)
# F-2: zero confirmations forbidden in production (reorg / unconfirmed admit race)
if PRODUCTION_LOCK and CHAIN_MIN_CONFIRMATIONS < 1:
    raise RuntimeError("ASP_CHAIN_MIN_CONFIRMATIONS must be >= 1 in production")

ALLOW_SKIP_SCREEN = os.getenv("ASP_ALLOW_SKIP_SCREEN", "").lower() in ("1", "true", "yes")
ALLOW_SKIP_SCREEN_MAINNET = os.getenv("ASP_ALLOW_SKIP_SCREEN_MAINNET", "").lower() in (
    "1",
    "true",
    "yes",
)


def skip_screen_allowed(chain_id: int | None = None) -> tuple[bool, str]:
    if PRODUCTION_LOCK:
        return False, "skip_screen_forbidden_in_production"
    if not ALLOW_SKIP_SCREEN:
        return False, "skip_screen_disabled"
    if chain_id in (1, 8453) and not ALLOW_SKIP_SCREEN_MAINNET:
        return False, "skip_screen_mainnet_forbidden"
    return True, ""


_auto_pub = os.getenv("ASP_AUTO_PUBLISH_ROOT", "").strip().lower()
if _auto_pub in ("1", "true", "yes"):
    AUTO_PUBLISH_ROOT = True
elif _auto_pub in ("0", "false", "no"):
    AUTO_PUBLISH_ROOT = False
else:
    AUTO_PUBLISH_ROOT = PRODUCTION_LOCK

POSTMAN_INTERVAL = int(os.getenv("ASP_POSTMAN_INTERVAL", "60"))
WATCHER_INTERVAL = int(os.getenv("ASP_WATCHER_INTERVAL", "15"))
WATCHER_LOOKBACK_BLOCKS = int(os.getenv("ASP_WATCHER_LOOKBACK_BLOCKS", "2000"))
# Widest eth_getLogs one poll asks for. Upstreams refuse wide ranges (413), and an uncapped catch-up
# re-asked for the whole backlog every poll, so one outage stalled admissions until the gap shrank.
WATCHER_MAX_RANGE = max(1, int(os.getenv("ASP_WATCHER_MAX_RANGE", "2000")))
# Require userSalt on admit (derive label). Dev escape: ASP_ALLOW_CLIENT_LABEL=1
REQUIRE_USER_SALT = os.getenv("ASP_REQUIRE_USER_SALT", "1").lower() not in ("0", "false", "no")
ALLOW_CLIENT_LABEL = os.getenv("ASP_ALLOW_CLIENT_LABEL", "").lower() in ("1", "true", "yes")
if PRODUCTION_LOCK and ALLOW_CLIENT_LABEL:
    raise RuntimeError("ASP_ALLOW_CLIENT_LABEL forbidden in production")

# F-4: never leave vault unbound in production
ALLOW_ANY_VAULT = os.getenv("ASP_ALLOW_ANY_VAULT", "").lower() in ("1", "true", "yes")
if PRODUCTION_LOCK and ALLOW_ANY_VAULT:
    raise RuntimeError("ASP_ALLOW_ANY_VAULT forbidden in production")

# Revoke labels not yet in ASP (SMT pollution) — forbidden in production
ALLOW_REVOKE_UNADMITTED = os.getenv("ASP_ALLOW_REVOKE_UNADMITTED", "").lower() in (
    "1",
    "true",
    "yes",
)
if PRODUCTION_LOCK and ALLOW_REVOKE_UNADMITTED:
    raise RuntimeError("ASP_ALLOW_REVOKE_UNADMITTED forbidden in production")

# Migration-only: accept pre-Fernet plaintext pending salts
ALLOW_LEGACY_PLAINTEXT_SALT = os.getenv("ASP_ALLOW_LEGACY_PLAINTEXT_SALT", "").lower() in (
    "1",
    "true",
    "yes",
)
if PRODUCTION_LOCK and ALLOW_LEGACY_PLAINTEXT_SALT:
    raise RuntimeError("ASP_ALLOW_LEGACY_PLAINTEXT_SALT forbidden in production")

# F-3: dedicated Fernet material required in production (no SCREEN_TOKEN fallback)
PENDING_SALT_KEY = (os.getenv("ASP_PENDING_SALT_KEY") or "").strip()
if PRODUCTION_LOCK and not PENDING_SALT_KEY:
    raise RuntimeError("ASP_PENDING_SALT_KEY required in production")

# KYT fee: no skip-escape in production; vault required when zkMe is configured
if PRODUCTION_LOCK and ALLOW_SKIP_KYT_FEE:
    raise RuntimeError("ASP_ALLOW_SKIP_KYT_FEE forbidden in production")
if PRODUCTION_LOCK and ZKME_MCH_NO and ZKME_API_KEY and not COMPLIANCE_VAULT:
    raise RuntimeError("ASP_COMPLIANCE_VAULT required in production when zkMe is configured")
if KYT_ENTITLEMENT_DAYS < 1:
    raise RuntimeError("ASP_KYT_ENTITLEMENT_DAYS must be >= 1")
# F-4: unbounded year length forbidden in production
if PRODUCTION_LOCK and KYT_ENTITLEMENT_DAYS > 366:
    raise RuntimeError("ASP_KYT_ENTITLEMENT_DAYS must be <= 366 in production")
# F-3: zero-fee escape forbidden in production
if PRODUCTION_LOCK and COMPLIANCE_FEE_WEI <= 0:
    raise RuntimeError("ASP_COMPLIANCE_FEE_WEI must be > 0 in production")
if PRODUCTION_LOCK and COMPLIANCE_FEE_USDC <= 0:
    raise RuntimeError("ASP_COMPLIANCE_FEE_USDC must be > 0 in production")

# F-1: auth min-length env escape — floor 16 under PRODUCTION_LOCK (ignore lower env)
if PRODUCTION_LOCK:
    AUTH_TOKEN_MIN_LEN = max(AUTH_TOKEN_MIN_LEN, 16)
    for _name, _tok in (
        ("ASP_SCREEN_TOKEN", SCREEN_TOKEN),
        ("ASP_ADMIN_TOKEN", ADMIN_TOKEN),
        ("ASP_POSTMAN_TOKEN", POSTMAN_TOKEN),
    ):
        if _tok and len(_tok) < AUTH_TOKEN_MIN_LEN:
            raise RuntimeError(
                f"{_name} must be at least {AUTH_TOKEN_MIN_LEN} characters in production"
            )

# F-4: screen auth must be configured at boot in production (not deferred 503)
if PRODUCTION_LOCK and not SCREEN_TOKEN:
    raise RuntimeError("ASP_SCREEN_TOKEN required in production")

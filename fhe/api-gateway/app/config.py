"""Typed application settings — validated at boot, env-driven (secrets-manager is [DEFERRED v1.1]).

All values have safe local-dev defaults; production overrides via env / .env. Nothing here is a
real secret — deploy-time env supplies those.
"""
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import AliasChoices


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Datastores
    database_url: str = "postgresql://siphon:siphon_secure_pass@localhost:5432/siphon_gateway"
    # The executor's note DB (Supabase/Postgres). Defaults to the gateway DB for local dev, mirroring
    # the executor's own NOTE_DB_URI fallback. The gateway reads the shared `notes` table (read-only).
    note_db_url: str = ""
    redis_url: str = "redis://localhost:6379/0"
    # prod|production refuses memory:// Redis and sqlite auto-create (local-dev escape hatches).
    siphon_env: str = Field(
        default="dev",
        validation_alias=AliasChoices("SIPHON_ENV", "APP_ENV", "siphon_env"),
    )

    # RPC endpoints (env-driven). Base is required; the others enable their chain when set.
    base_mainnet_rpc: str = "https://mainnet.base.org"
    eth_sepolia_rpc: str = "https://ethereum-sepolia-rpc.publicnode.com"
    arbitrum_rpc: str = "https://arb1.arbitrum.io/rpc"


    # Internal downstreams (fixed hosts; SSRF-safe, never user-supplied)
    executor_url: str = "http://localhost:5005"
    relayer_url: str = "http://localhost:5010"
    indexer_url_base: str = "http://localhost:42069"
    indexer_url_sepolia: str = "http://localhost:42070"
    executor_api_token: str = "testtoken123"  # gateway->executor internal auth (existing API_TOKEN)

    # v5 (VaultKernel) per-chain services. Base uses executor_url / asp_url. Every other chain
    # needs its OWN hosts and tokens — there is no fallback to Base's, because Arbitrum's stack runs
    # on a separate, lower-assurance box and Sepolia is a dev-key testnet (G-5). Unset ⇒ the chain
    # answers 503 instead of borrowing another chain's credentials.
    executor_url_42161: str = ""
    executor_api_token_42161: str = ""
    executor_url_11155111: str = ""
    executor_api_token_11155111: str = ""
    asp_url: str = "http://localhost:5057"
    asp_screen_token: str = ""
    asp_postman_token: str = ""
    asp_url_42161: str = ""
    asp_screen_token_42161: str = ""
    asp_postman_token_42161: str = ""
    asp_url_11155111: str = ""
    asp_screen_token_11155111: str = ""
    asp_postman_token_11155111: str = ""
    # Ponder v5 indexers (serve /state/leaves). No defaults: each must be an operator-owned host
    # set explicitly per chain (G-12).
    v5_indexer_url_8453: str = ""
    v5_indexer_url_42161: str = ""
    v5_indexer_url_11155111: str = ""
    # Solana Devnet (900002): our ZK vault program. The executor that serves its order and relay
    # routes, and the Solana ASP (solasp), are per-chain settings like every other chain's.
    solana_devnet_rpc: str = "https://api.devnet.solana.com"
    solana_program_id: str = "BktHHQ8KJpfnwLNMEqnh9uANEyuFa1qYtbhzHwCKMEDe"
    solana_usdc_mint: str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"  # Circle devnet USDC
    executor_url_900002: str = ""
    executor_api_token_900002: str = ""
    asp_url_900002: str = ""
    asp_screen_token_900002: str = ""
    asp_postman_token_900002: str = ""
    # Free Devnet keys: one per Solana wallet, usable on chain 900002 only.
    devnet_keys_enabled: bool = True
    # API key ids allowed to use admin-only chains (Sepolia). Everyone else gets 403.
    v5_admin_api_key_ids: list[str] = []
    # A relayed spend waits for gas + broadcast inside the executor; 10s cut it off mid-send (G-4).
    relay_timeout_seconds: float = 120.0

    # Secrets (env for v1)
    api_key_pepper: str = "dev-pepper-change-me"
    billing_ref_hmac_key: str = "dev-billing-ref-change-me"
    admin_api_token: str = ""  # admin credit-grant route; 503 when unset (never open on empty secret)
    # USDC collector for self-serve API key purchases (plain ERC-20 transfer from wallet).
    # Empty → falls back to the Base executor address used for arming fees.
    api_credit_collector: str = ""

    # Confirmations before state mutation (env-configurable; chain_id -> confirmations)
    confirmations: dict[int, int] = {8453: 2, 42161: 2, 11155111: 2}

    # Background reconciler — pulls the executor's `execution` outbox into per-key usage_events.
    # Enabled by default so a deployed gateway actually bills executions; disable on workers that
    # shouldn't own reconciliation (and it's off in tests via the app factory).
    reconcile_enabled: bool = True
    reconcile_interval_seconds: float = 30.0

    # Rate limits (per key, per minute)
    rate_read_per_min: int = 100
    rate_proof_per_min: int = 10
    rate_validate_per_min: int = 30

    # Compliance receipt signing. HMAC in v1; the key_id is embedded in every receipt so a future
    # rotation (or a move to Ed25519) stays verifiable against historical receipts.
    receipt_signing_key: str = "dev-receipt-signing-change-me"
    receipt_signing_key_id: str = "hmac-v1"

    # Webhooks
    webhook_enabled: bool = True
    webhook_timeout_seconds: float = 10.0
    webhook_max_attempts: int = 6
    webhook_worker_interval_seconds: float = 5.0
    # Deliveries only go to https:// in production; http:// is allowed for local sinks.
    webhook_require_https: bool = True

    # Chain receipt monitor. Run this in exactly one gateway worker; it advances submitted
    # operations and therefore emits confirmation/failure webhooks without requiring client polls.
    operation_monitor_enabled: bool = True
    operation_monitor_interval_seconds: float = 15.0

    # Sandbox: sk_test_ keys run against deterministic fixtures instead of chain/executor.
    sandbox_enabled: bool = True

    # Shielded keeper — the enclave that custodies managed-account note material. A fixed internal
    # host, never user-supplied. There is deliberately NO gateway-side derivation fallback: deriving
    # notes outside the enclave would defeat the custody model, so an unreachable keeper is a 503.
    keeper_url: str = "http://localhost:5020"
    keeper_api_token: str = ""
    keeper_timeout_seconds: float = 15.0
    managed_accounts_enabled: bool = True

    # Input size caps
    max_server_key_bytes: int = 30 * 1024 * 1024
    max_ciphertext_bytes: int = 256 * 1024

    # CORS (explicit allowlist; never * with credentials)
    cors_allowed_origins: list[str] = []


def get_settings() -> Settings:
    return Settings()

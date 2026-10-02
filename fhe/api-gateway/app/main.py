"""FastAPI app factory — the sole public door to Siphon's shielded pool + confidential execution.

v1 secure spine. This module mounts the router surface; auth dependencies, error handlers, and
middleware are wired in their respective tasks. The OpenAPI document FastAPI generates from these
routers is the published contract (the SDK is a consumer).
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

from app.errors import install_error_handlers
from app.observability import init_sentry
from app.logging_config import configure_logging, install_request_id_middleware
from app.routers import (
    account,
    accounts,
    admin,
    batches,
    business_accounts,
    compliance,
    consolidation,
    fhe_keys,
    health,
    keys,
    notes,
    operations,
    policies,
    pool,
    payouts,
    strategies,
    subaccounts,
    v5,
    webhooks,
    withdrawals,
)


def _rfc7807_media_type(schema: dict) -> dict:
    """Strict RFC 7807: error responses that carry a Problem body must expose it ONLY under
    `application/problem+json` (spec §6.2 names that exact media type). FastAPI's `model=` also
    injects a redundant `application/json` variant of the same schema — drop it wherever the
    problem+json variant is present, so the published contract is the media type the gateway
    actually returns."""
    for path_item in schema.get("paths", {}).values():
        for operation in path_item.values():
            if not isinstance(operation, dict):
                continue
            for response in operation.get("responses", {}).values():
                content = response.get("content")
                if content and "application/problem+json" in content:
                    content.pop("application/json", None)
    return schema


_WALLET_INTENT_V2_OPERATIONS = {
    "abortStrategy",
    "confirmConsolidation",
    "confirmDeposit",
    "confirmWithdrawal",
    "createAccount",
    "createAccountDeposit",
    "createBatch",
    "createConsolidation",
    "createDeposit",
    "createPayout",
    "createStrategy",
    "createWithdrawal",
    "purchaseApiKey",
    "registerFheServerKey",
    "submitOperationTransaction",
    "verifyComplianceFee",
}


def _document_wallet_intents(schema: dict) -> dict:
    """Expose request-signing headers that are verified from the raw Request object.

    FastAPI cannot infer these parameters because the dependency reads the cached body and headers
    directly. They are conditionally optional only for `sk_test_` sandbox keys.
    """
    descriptions = {
        "X-Wallet-Address": "User-controlled EVM wallet address.",
        "X-Signature": "EIP-191 signature over the canonical Siphon API v2 intent.",
        "X-Timestamp": "Unix timestamp; live requests must be within 300 seconds.",
        "X-Nonce": "Unique wallet-global nonce, consumed once; maximum 128 characters.",
        "Idempotency-Key": "Unique request key. Required for relay and advanced external side effects.",
    }
    for path_item in schema.get("paths", {}).values():
        for operation in path_item.values():
            if not isinstance(operation, dict):
                continue
            if operation.get("operationId") not in _WALLET_INTENT_V2_OPERATIONS:
                continue
            operation["x-siphon-wallet-intent"] = "v2"
            params = operation.setdefault("parameters", [])
            present = {(p.get("in"), p.get("name")) for p in params if isinstance(p, dict)}
            for name, description in descriptions.items():
                if ("header", name) not in present:
                    params.append(
                        {
                            "name": name,
                            "in": "header",
                            "required": False,
                            "description": description + " Required for live keys; omitted in sandbox.",
                            "schema": {"type": "string"},
                        }
                    )
    return schema


def create_app(*, start_reconciler: bool = True) -> FastAPI:
    configure_logging()

    # Boot-time check for required RPC config (fail-fast on startup)
    from app.config import get_settings
    from app.boot_guards import validate_production_boot

    settings = get_settings()
    validate_production_boot(settings)
    if not settings.base_mainnet_rpc:
        raise RuntimeError("BASE_MAINNET_RPC config is missing or empty")

    # Background reconciler: on real boot, run the loop that pulls the executor's `execution` outbox
    # into per-key usage. Guarded by both the `start_reconciler` factory flag (tests pass False — no
    # threads/network under the ASGI test transport) and the `reconcile_enabled` setting.
    import os
    run_reconciler = (
        start_reconciler and 
        settings.reconcile_enabled and 
        os.getenv("RUN_RECONCILER_IN_WORKER", "1") == "1"
    )


    # Webhook delivery shares the reconciler's gating: tests pass start_reconciler=False so no
    # threads or outbound HTTP run under the ASGI test transport.
    run_webhooks = (
        start_reconciler
        and settings.webhook_enabled
        and os.getenv("RUN_WEBHOOKS_IN_WORKER", "1") == "1"
    )
    run_operation_monitor = (
        start_reconciler
        and settings.operation_monitor_enabled
        and os.getenv("RUN_OPERATION_MONITOR_IN_WORKER", "1") == "1"
    )

    def _ensure_db_schema() -> None:
        """Apply Alembic migrations on boot so claim/idempotency tables exist even if the
        container start command skips the docker entrypoint (common on Railway overrides)."""
        import logging
        from pathlib import Path

        from alembic import command
        from alembic.config import Config

        log = logging.getLogger("api-gateway.boot")
        ini = Path(__file__).resolve().parent.parent / "alembic.ini"
        if not ini.is_file():
            log.warning("alembic.ini missing at %s; skipping schema migrate", ini)
            return
        log.info("running alembic upgrade head (%s)", ini)
        command.upgrade(Config(str(ini)), "head")
        log.info("alembic upgrade head complete")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        _ensure_db_schema()
        stops = []
        if run_reconciler:
            from app.services.reconcile_worker import start_reconcile_worker
            stops.append(start_reconcile_worker(
                enabled=settings.reconcile_enabled,
                interval_seconds=settings.reconcile_interval_seconds,
            ))
        if run_webhooks:
            from app.services.webhook_worker import start_webhook_worker
            stops.append(start_webhook_worker(
                enabled=settings.webhook_enabled,
                interval_seconds=settings.webhook_worker_interval_seconds,
            ))
        if run_operation_monitor:
            from app.services.operation_monitor import start_operation_monitor
            stops.append(start_operation_monitor(
                enabled=settings.operation_monitor_enabled,
                interval_seconds=settings.operation_monitor_interval_seconds,
            ))
        try:
            yield
        finally:
            for stop in stops:
                if stop is not None:
                    stop.set()

    # Error tracking. Inert unless SENTRY_DSN is set; see app/observability.py for the redaction
    # rules, which are what make an external reporter acceptable in the process that holds API
    # keys, wallet signatures and proof payloads.
    init_sentry("api-gateway")

    app = FastAPI(
        title="Siphon Commercial API",
        version="2.0.0",
        description=(
            "Non-custodial private money movement on Siphon v5 (Base, Arbitrum One). API keys grant "
            "service access only; wallet-bound intents and client-held ZK note secrets retain spend "
            "authority. Proofs are generated client-side with @siphon/sdk-ts."
        ),
        lifespan=lifespan,
    )

    install_request_id_middleware(app)
    install_error_handlers(app)
    for module in (
        health,
        notes,
        withdrawals,
        consolidation,
        strategies,
        fhe_keys,
        pool,
        account,
        keys,
        admin,
        # Platform surface: durable operations, webhooks, tenancy, compliance evidence, batch
        # settlement, and server-enforced policy.
        operations,
        business_accounts,
        payouts,
        accounts,
        webhooks,
        subaccounts,
        compliance,
        batches,
        policies,
        v5,
    ):
        # The v1 note/withdraw/consolidation/pool/managed-account routes build calls for the
        # retired Entrypoint protocol; v5 chains are served by accounts/deposits, payouts and
        # /v1/chains. Kept for existing sandbox integrations, marked deprecated in the contract.
        legacy = module in (notes, withdrawals, consolidation, pool, accounts)
        app.include_router(module.router, deprecated=True if legacy else None)

    def custom_openapi() -> dict:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title, version=app.version, description=app.description, routes=app.routes,
        )
        app.openapi_schema = _document_wallet_intents(_rfc7807_media_type(schema))
        return app.openapi_schema

    app.openapi = custom_openapi
    return app


app = create_app()

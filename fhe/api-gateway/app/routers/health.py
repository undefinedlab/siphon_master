"""Health / readiness / liveness — split per observability rules (NOT combined, spec §10).

liveness: process only, zero I/O (is the process up?).
readiness: can we serve traffic? checks Postgres + Redis + executor reachability.
health: basic status + version.
"""
from fastapi import APIRouter, Depends

from app.config import get_settings
from app.errors import DownstreamUnavailable
from app.schemas.errors_openapi import problem_response

router = APIRouter(prefix="/v1", tags=["Health"])

_PUBLIC = {"security": []}
_UNAVAILABLE = {503: problem_response("downstream_unavailable — a checked dependency is down.")}


def check_dependencies() -> None:
    """Probe Postgres, Redis, and the executor; raise DownstreamUnavailable if any is unreachable.

    Overridden in tests. Kept as a dependency (not inline) so readiness stays declarative and the
    failure path is exercised without real infra.
    """
    from sqlalchemy import text

    from app.adapters.executor import ExecutorClient
    from app.repository.redis_client import get_redis
    from app.repository.session import SessionLocal

    settings = get_settings()
    # Postgres
    try:
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
    except Exception as e:
        raise DownstreamUnavailable("database unreachable") from e
    # Redis
    try:
        get_redis().ping()
    except Exception as e:
        raise DownstreamUnavailable("redis unreachable") from e
    # Executor (cheap GET on its health)
    try:
        ExecutorClient(base_url=settings.executor_url, api_token=settings.executor_api_token)._request("GET", "/health")
    except DownstreamUnavailable:
        raise
    except Exception as e:
        raise DownstreamUnavailable("executor unreachable") from e


@router.get("/liveness", operation_id="getLiveness", summary="Process liveness (no downstream checks)", openapi_extra=_PUBLIC)
async def get_liveness():
    return {"status": "alive"}


@router.get("/health", operation_id="getHealth", summary="Basic service status", openapi_extra=_PUBLIC)
async def get_health():
    return {"status": "ok", "version": "1.0.0"}


@router.get(
    "/readiness",
    operation_id="getReadiness",
    summary="Can serve traffic (checks executor/redis/pg)",
    openapi_extra=_PUBLIC,
    responses=_UNAVAILABLE,
)
async def get_readiness(_: None = Depends(check_dependencies)):
    return {"status": "ready"}

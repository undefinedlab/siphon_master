"""Gateway error types → RFC 7807 problem responses.

Task 7 expands this into the full registry + exception handlers + request-id middleware. For now it
defines the base class and the errors earlier tasks raise, each carrying its (status, error_code)
from spec §6.2 so the mapping is fixed at the source, not in the handler.
"""
from app.schemas.common import ErrorCode


class GatewayError(Exception):
    """Base for all gateway errors. Carries the HTTP status + stable error_code (spec §6.2).

    `headers` lets an error attach response headers (e.g. Retry-After on 429).
    """
    status: int = 500
    error_code: ErrorCode = ErrorCode.downstream_unavailable
    title: str = "Error"

    def __init__(self, detail: str | None = None, *, headers: dict[str, str] | None = None):
        self.detail = detail or self.title
        self.headers = headers or {}
        super().__init__(self.detail)


class RateLimited(GatewayError):
    status = 429
    error_code = ErrorCode.rate_limited
    title = "Rate limit exceeded"

    def __init__(self, *, retry_after: int, detail: str | None = None):
        super().__init__(detail or "Per-key rate limit exceeded.",
                         headers={"Retry-After": str(int(retry_after))})


class Unauthorized(GatewayError):
    status = 401
    error_code = ErrorCode.unauthorized
    title = "Unauthorized"


class StaleSignature(GatewayError):
    status = 401
    error_code = ErrorCode.stale_signature
    title = "Stale signature"


class ReplayedRequest(GatewayError):
    status = 409
    error_code = ErrorCode.replayed_request
    title = "Replayed request"


class NotFound(GatewayError):
    status = 404
    error_code = ErrorCode.not_found
    title = "Not found"


class Forbidden(GatewayError):
    status = 403
    error_code = ErrorCode.forbidden
    title = "Forbidden"


class BadRequest(GatewayError):
    status = 400
    error_code = ErrorCode.bad_request
    title = "Bad request"


class InsufficientQuota(GatewayError):
    status = 402
    error_code = ErrorCode.insufficient_quota
    title = "Insufficient quota"


class Conflict(GatewayError):
    status = 409
    error_code = ErrorCode.conflict
    title = "Conflict"


class NeedsConsolidation(GatewayError):
    status = 409
    error_code = ErrorCode.needs_consolidation
    title = "Note consolidation required"


class RequestInProgress(GatewayError):
    status = 409
    error_code = ErrorCode.request_in_progress
    title = "Request in progress"


class FheKeysMissing(GatewayError):
    status = 409
    error_code = ErrorCode.fhe_keys_missing
    title = "FHE keys not registered"


class IdempotencyKeyReuse(GatewayError):
    status = 422
    error_code = ErrorCode.idempotency_key_reuse
    title = "Idempotency key reuse"


class Sanctioned(GatewayError):
    status = 451
    error_code = ErrorCode.sanctioned
    title = "Sanctioned address"


class DownstreamUnavailable(GatewayError):
    status = 503
    error_code = ErrorCode.downstream_unavailable
    title = "Downstream unavailable"


class AspUnavailable(GatewayError):
    status = 503
    error_code = ErrorCode.asp_unavailable
    title = "Compliance service unavailable"


class ProofFailed(GatewayError):
    status = 422
    error_code = ErrorCode.proof_failed
    title = "Proof rejected"


class TransactionFailed(GatewayError):
    status = 502
    error_code = ErrorCode.transaction_failed
    title = "Transaction failed"


class VaultExitOnly(GatewayError):
    status = 409
    error_code = ErrorCode.vault_exit_only
    title = "Vault is withdraw-only"


class VaultGenerationRequired(GatewayError):
    status = 409
    error_code = ErrorCode.vault_generation_required
    title = "Vault generation required"


class VaultGenerationNotActive(GatewayError):
    status = 409
    error_code = ErrorCode.vault_generation_not_active
    title = "Vault generation is not active"


class VaultGenerationUnavailable(GatewayError):
    status = 503
    error_code = ErrorCode.vault_generation_unavailable
    title = "Active vault generation unavailable"


class CompliancePending(GatewayError):
    status = 409
    error_code = ErrorCode.compliance_pending
    title = "Compliance review pending"


class ComplianceDenied(GatewayError):
    status = 451
    error_code = ErrorCode.compliance_denied
    title = "Compliance screening denied"


class ComplianceFeeRequired(GatewayError):
    """The depositing wallet has not paid its yearly compliance (KYT) fee on this chain."""
    status = 402
    error_code = ErrorCode.compliance_fee_required
    title = "Compliance fee required"


class WithdrawCreditRequired(GatewayError):
    """The relayer's prepaid gas credit for this wallet is too low. The proof is still valid:
    top up, or submit the spend yourself with submission_mode=unsigned."""
    status = 402
    error_code = ErrorCode.withdraw_credit_required
    title = "Relayer credit required"


_ERROR_TYPE_BASE = "https://api.siphon.money/errors/"


def _problem_dict(*, status: int, title: str, detail: str, error_code: str,
                  instance: str, request_id: str | None) -> dict:
    return {
        "type": _ERROR_TYPE_BASE + error_code.replace("_", "-"),
        "title": title,
        "status": status,
        "detail": detail,
        "instance": instance,
        "request_id": request_id,
        "error_code": error_code,
    }


def install_error_handlers(app) -> None:
    """Map every exception to an RFC 7807 application/problem+json response with a request_id.

    Never leaks stack traces, SQL, internal ids, or DB errors — an unhandled exception becomes a
    generic 500 problem; only GatewayError carries a caller-facing detail.
    """
    from fastapi import Request
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse
    from starlette.exceptions import HTTPException as StarletteHTTPException

    def _response(status: int, body: dict, headers: dict[str, str] | None = None) -> JSONResponse:
        return JSONResponse(status_code=status, content=body,
                            media_type="application/problem+json", headers=headers or {})

    @app.exception_handler(GatewayError)
    async def _gateway(request: Request, exc: GatewayError):
        rid = getattr(request.state, "request_id", None)
        body = _problem_dict(status=exc.status, title=exc.title, detail=exc.detail,
                             error_code=exc.error_code.value, instance=request.url.path, request_id=rid)
        return _response(exc.status, body, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        rid = getattr(request.state, "request_id", None)
        body = _problem_dict(status=422, title="Invalid request", detail="Request validation failed.",
                             error_code=ErrorCode.bad_request.value, instance=request.url.path, request_id=rid)
        return _response(422, body)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        rid = getattr(request.state, "request_id", None)
        # Map a raw HTTPException (e.g. the 501 stubs) to a problem without leaking internals.
        code = {400: ErrorCode.bad_request, 401: ErrorCode.unauthorized, 403: ErrorCode.forbidden,
                404: ErrorCode.not_found, 429: ErrorCode.rate_limited}.get(exc.status_code,
                                                                           ErrorCode.downstream_unavailable)
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        body = _problem_dict(status=exc.status_code, title="Error", detail=detail,
                             error_code=code.value, instance=request.url.path, request_id=rid)
        return _response(exc.status_code, body)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        rid = getattr(request.state, "request_id", None)
        # Log server-side; never leak internals to the client.
        import logging

        logging.getLogger("siphon.gateway").exception(
            "unhandled %s %s rid=%s: %s",
            request.method,
            request.url.path,
            rid,
            exc,
        )
        body = _problem_dict(status=500, title="Internal error", detail="An unexpected error occurred.",
                             error_code=ErrorCode.downstream_unavailable.value,
                             instance=request.url.path, request_id=rid)
        return _response(500, body)

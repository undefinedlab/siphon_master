class SiphonError(Exception):
    def __init__(self, message: str, error_code: str, status: int, request_id: str = None, error_type: str = None, detail: str = None):
        super().__init__(message)
        self.error_code = error_code
        self.status = status
        self.request_id = request_id
        self.error_type = error_type
        self.detail = detail


class UnauthorizedError(SiphonError):
    pass


class StaleSignatureError(SiphonError):
    pass


class ForbiddenError(SiphonError):
    pass


class InsufficientQuotaError(SiphonError):
    pass


class NotFoundError(SiphonError):
    pass


class ConflictError(SiphonError):
    pass


class ReplayedRequestError(SiphonError):
    pass


class NeedsConsolidationError(SiphonError):
    pass


class RequestInProgressError(SiphonError):
    pass


class FheKeysMissingError(SiphonError):
    pass


class IdempotencyKeyReuseError(SiphonError):
    pass


class SanctionedError(SiphonError):
    pass


class RateLimitedError(SiphonError):
    pass


class BadRequestError(SiphonError):
    pass


class DownstreamUnavailableError(SiphonError):
    pass


def map_error_code_to_exception(
    message: str, error_code: str, status: int, request_id: str = None, error_type: str = None, detail: str = None
) -> SiphonError:
    code = (error_code or "").strip().lower()

    if code == "unauthorized":
        return UnauthorizedError(message, error_code, status, request_id, error_type, detail)
    elif code == "stale_signature":
        return StaleSignatureError(message, error_code, status, request_id, error_type, detail)
    elif code == "forbidden":
        return ForbiddenError(message, error_code, status, request_id, error_type, detail)
    elif code == "insufficient_quota":
        return InsufficientQuotaError(message, error_code, status, request_id, error_type, detail)
    elif code == "not_found":
        return NotFoundError(message, error_code, status, request_id, error_type, detail)
    elif code == "conflict":
        return ConflictError(message, error_code, status, request_id, error_type, detail)
    elif code == "replayed_request":
        return ReplayedRequestError(message, error_code, status, request_id, error_type, detail)
    elif code == "needs_consolidation":
        return NeedsConsolidationError(message, error_code, status, request_id, error_type, detail)
    elif code == "request_in_progress":
        return RequestInProgressError(message, error_code, status, request_id, error_type, detail)
    elif code == "fhe_keys_missing":
        return FheKeysMissingError(message, error_code, status, request_id, error_type, detail)
    elif code == "idempotency_key_reuse":
        return IdempotencyKeyReuseError(message, error_code, status, request_id, error_type, detail)
    elif code == "sanctioned":
        return SanctionedError(message, error_code, status, request_id, error_type, detail)
    elif code == "rate_limited":
        return RateLimitedError(message, error_code, status, request_id, error_type, detail)
    elif code == "bad_request":
        return BadRequestError(message, error_code, status, request_id, error_type, detail)
    elif code == "downstream_unavailable":
        return DownstreamUnavailableError(message, error_code, status, request_id, error_type, detail)
    else:
        return SiphonError(message, error_code or "unknown_error", status, request_id, error_type, detail)

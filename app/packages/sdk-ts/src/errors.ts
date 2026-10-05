export class SiphonError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly type?: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnauthorizedError extends SiphonError {}
export class StaleSignatureError extends SiphonError {}
export class ForbiddenError extends SiphonError {}
export class InsufficientQuotaError extends SiphonError {}
export class NotFoundError extends SiphonError {}
export class ConflictError extends SiphonError {}
export class ReplayedRequestError extends SiphonError {}
export class NeedsConsolidationError extends SiphonError {}
export class RequestInProgressError extends SiphonError {}
export class FheKeysMissingError extends SiphonError {}
export class IdempotencyKeyReuseError extends SiphonError {}
export class SanctionedError extends SiphonError {}
export class RateLimitedError extends SiphonError {}
export class BadRequestError extends SiphonError {}
export class DownstreamUnavailableError extends SiphonError {}

export function mapErrorCodeToException(
  message: string,
  errorCode: string,
  status: number,
  requestId?: string,
  type?: string,
  detail?: string
): SiphonError {
  const normalizedCode = (errorCode || "").trim().toLowerCase();

  switch (normalizedCode) {
    case "unauthorized":
      return new UnauthorizedError(message, errorCode, status, requestId, type, detail);
    case "stale_signature":
      return new StaleSignatureError(message, errorCode, status, requestId, type, detail);
    case "forbidden":
      return new ForbiddenError(message, errorCode, status, requestId, type, detail);
    case "insufficient_quota":
      return new InsufficientQuotaError(message, errorCode, status, requestId, type, detail);
    case "not_found":
      return new NotFoundError(message, errorCode, status, requestId, type, detail);
    case "conflict":
      return new ConflictError(message, errorCode, status, requestId, type, detail);
    case "replayed_request":
      return new ReplayedRequestError(message, errorCode, status, requestId, type, detail);
    case "needs_consolidation":
      return new NeedsConsolidationError(message, errorCode, status, requestId, type, detail);
    case "request_in_progress":
      return new RequestInProgressError(message, errorCode, status, requestId, type, detail);
    case "fhe_keys_missing":
      return new FheKeysMissingError(message, errorCode, status, requestId, type, detail);
    case "idempotency_key_reuse":
      return new IdempotencyKeyReuseError(message, errorCode, status, requestId, type, detail);
    case "sanctioned":
      return new SanctionedError(message, errorCode, status, requestId, type, detail);
    case "rate_limited":
      return new RateLimitedError(message, errorCode, status, requestId, type, detail);
    case "bad_request":
      return new BadRequestError(message, errorCode, status, requestId, type, detail);
    case "downstream_unavailable":
      return new DownstreamUnavailableError(message, errorCode, status, requestId, type, detail);
    default:
      return new SiphonError(message, errorCode || "unknown_error", status, requestId, type, detail);
  }
}

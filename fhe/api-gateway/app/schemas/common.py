"""Shared schema primitives.

StrictModel: request models reject unknown fields (strict reader — catches caller bugs early).
Problem: the RFC 7807 error envelope surfaced on every error, with the stable `error_code` machine
keys (spec §6.2) that SDKs branch on. This is part of the published contract, not handler detail.
"""
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class ErrorCode(str, Enum):
    """Stable machine keys SDKs branch on (spec §6.2). The dereferenceable `type` URL and HTTP
    status accompany each, but this string is the contract-level switch."""
    unauthorized = "unauthorized"                  # 401
    stale_signature = "stale_signature"            # 401
    forbidden = "forbidden"                        # 403
    insufficient_quota = "insufficient_quota"      # 402
    not_found = "not_found"                         # 404
    conflict = "conflict"                           # 409
    replayed_request = "replayed_request"           # 409
    needs_consolidation = "needs_consolidation"     # 409
    request_in_progress = "request_in_progress"     # 409
    fhe_keys_missing = "fhe_keys_missing"           # 409
    idempotency_key_reuse = "idempotency_key_reuse" # 422
    sanctioned = "sanctioned"                       # 451
    rate_limited = "rate_limited"                    # 429
    bad_request = "bad_request"                      # 400
    downstream_unavailable = "downstream_unavailable"  # 503
    asp_unavailable = "asp_unavailable"              # 503
    compliance_pending = "compliance_pending"        # 409
    compliance_denied = "compliance_denied"          # 451
    compliance_fee_required = "compliance_fee_required"  # 402
    withdraw_credit_required = "withdraw_credit_required"  # 402
    asp_root_stale = "asp_root_stale"                # 503
    proof_failed = "proof_failed"                    # 422
    transaction_failed = "transaction_failed"        # 502
    vault_exit_only = "vault_exit_only"              # 409
    vault_generation_required = "vault_generation_required"  # 409
    vault_generation_not_active = "vault_generation_not_active"  # 409
    vault_generation_unavailable = "vault_generation_unavailable"  # 503


class StrictModel(BaseModel):
    """Base for request bodies: reject unknown fields (extra='forbid')."""
    model_config = ConfigDict(extra="forbid")


class Problem(BaseModel):
    """RFC 7807 application/problem+json envelope (the standard error shape for every error)."""
    type: str = Field(
        description="Dereferenceable docs URL for the error class.",
        examples=["https://api.siphon.money/errors/insufficient-quota"],
    )
    title: str = Field(description="Short, human-readable summary.", examples=["Insufficient quota"])
    status: int = Field(description="HTTP status code.", examples=[402])
    detail: str = Field(description="Human-readable explanation of this occurrence.",
                        examples=["Monthly execution quota exceeded."])
    instance: str | None = Field(default=None, description="The request path.", examples=["/v1/strategies"])
    request_id: str | None = Field(default=None, description="Correlation id for this request.",
                                   examples=["req_a1b2c3"])
    error_code: ErrorCode = Field(description="Stable machine key SDKs branch on.",
                                  examples=[ErrorCode.insufficient_quota])

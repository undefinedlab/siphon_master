"""Business-facing operation states for workflows backed by Hard ASP and ZK/FHE internals."""
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict


class BusinessOperationState(str, Enum):
    created = "created"
    awaiting_deposit = "awaiting_deposit"
    screening = "screening"
    compliance_pending = "compliance_pending"
    ready = "ready"
    denied = "denied"
    authorized = "authorized"
    proving = "proving"
    queued = "queued"
    submitted = "submitted"
    confirmed = "confirmed"
    failed = "failed"
    revoked = "revoked"
    ragequit_submitted = "ragequit_submitted"
    ragequit_confirmed = "ragequit_confirmed"


class OperationStatus(BaseModel):
    """Safe public projection; cryptographic state remains inside Siphon services."""

    model_config = ConfigDict(extra="forbid")

    operation_id: str
    status: BusinessOperationState
    updated_at: datetime
    retryable: bool = False

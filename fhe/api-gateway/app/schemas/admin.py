from datetime import datetime
from pydantic import BaseModel, Field


class CreditGrantRequest(BaseModel):
    amount_minor: int = Field(..., gt=0, description="Amount in integer minor units (must be > 0).")
    reason: str = Field(..., min_length=1, description="Reason for the credit grant (must be non-empty).")


class CreditGrantResponse(BaseModel):
    api_key_id: str
    amount_minor: int
    balance_minor: int
    reason: str
    granted_at: datetime

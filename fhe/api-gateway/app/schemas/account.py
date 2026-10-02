from pydantic import BaseModel, Field


class UsageSummary(BaseModel):
    period: str
    counts_by_event_type: dict[str, int]
    total_amount_minor: int
    granted_credit_minor: int
    balance_minor: int


class FeeQuote(BaseModel):
    arming_fee_minor: int = Field(
        description="Part A: fixed arming fee in USDC minor units, charged when a strategy arms."
    )
    execution_fee_minor: int = Field(
        description=(
            "Part B floor: minimum execution fee in USDC minor units. The actual execution fee "
            "is max(this floor, 0.20% of trade notional) plus gas_reimbursement_minor, plus a "
            "duration surcharge for orders that stay armed across days."
        )
    )
    gas_reimbursement_minor: int = Field(
        description=(
            "Flat gas reimbursement in USDC minor units, charged on execution in addition to "
            "execution_fee_minor."
        )
    )

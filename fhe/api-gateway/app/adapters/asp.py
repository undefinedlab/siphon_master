"""Internal client for the Hard ASP read and screening interface.

The commercial API never exposes ASP credentials or cryptographic membership data directly.
"""
from typing import Literal, TypeVar

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.adapters.base import DownstreamClient
from app.errors import AspUnavailable


class _AspWireModel(BaseModel):
    """Strict wire contract so ASP drift fails closed at the gateway boundary."""

    model_config = ConfigDict(extra="forbid", strict=True)


class AssociationSetRoot(_AspWireModel):
    setId: str
    root: str
    size: int
    ipfsCid: str | None
    depth: int


class ScreeningDependencies(_AspWireModel):
    listsOk: bool | None = None
    listCounts: dict[str, int] = Field(default_factory=dict)
    indexer: str | None = None
    explorer: str | None = None
    bridges: str | None = None
    oracleFailClosed: bool | None = None


class DeferredAssociationSet(_AspWireModel):
    admitted: bool
    deferred: bool
    reason: str


class ScreeningDecision(_AspWireModel):
    decision: Literal["admit", "deny", "pending"]
    decisionId: str | None
    setId: str
    reasons: list[str]
    deps: ScreeningDependencies
    policyVersion: str
    commitment: str | None
    associationSet: DeferredAssociationSet | None = None


_AspModel = TypeVar("_AspModel", bound=_AspWireModel)


def _validate_response(model: type[_AspModel], payload: dict, description: str) -> _AspModel:
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise AspUnavailable(f"ASP returned an invalid {description}.") from exc


class AspClient(DownstreamClient):
    def __init__(
        self,
        base_url: str,
        *,
        screen_token: str,
        transport: httpx.BaseTransport | None = None,
    ):
        if not screen_token.strip():
            raise ValueError("screen_token must not be blank")
        super().__init__(base_url, transport=transport)
        self._screen_token = screen_token

    def _screen_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._screen_token}"}

    def get_root(self) -> AssociationSetRoot:
        payload = self._request("GET", "/set/root", headers=self._screen_headers())
        return _validate_response(AssociationSetRoot, payload, "association-set root")

    def screen_deposit(
        self,
        *,
        chain_id: int,
        depositor: str,
        tx_hash: str | None = None,
        commitment: str | None = None,
        asset: str | None = None,
    ) -> ScreeningDecision:
        payload = {
            "chainId": chain_id,
            "depositor": depositor,
        }
        payload.update(
            {
                key: value
                for key, value in {
                    "txHash": tx_hash,
                    "commitment": commitment,
                    "asset": asset,
                }.items()
                if value is not None
            }
        )
        response = self._request(
            "POST",
            "/screen",
            headers=self._screen_headers(),
            json=payload,
        )
        return _validate_response(ScreeningDecision, response, "screening decision")

    def _as_client_error(self, resp: httpx.Response) -> Exception:
        """Collapse internal ASP failures into one stable, non-leaking API error."""
        return AspUnavailable("Compliance screening is temporarily unavailable.")

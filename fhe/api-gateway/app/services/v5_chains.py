"""Siphon v5 (VaultKernel + ComplianceHub) deployments and the per-chain services behind them.

The addresses are immutable deployments and mirror siphon-app's NEXT_PUBLIC_V3_* values and
@siphon/sdk-ts `v5/constants.ts`; tests/unit/test_v5_chains.py pins the two. Service hosts are
settings (never user input), resolved per chain because Arbitrum runs its own executor + ASP.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from app.adapters.base import DownstreamClient
from app.adapters.executor import ExecutorClient
from app.config import get_settings
from app.errors import AspUnavailable, BadRequest, ComplianceFeeRequired, DownstreamUnavailable, Forbidden

NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
PROGRAM_VERSION = 5


@dataclass(frozen=True)
class V5Chain:
    chain_id: int
    name: str
    vault_kernel: str
    compliance_hub: str
    asset_adapter: str  # ERC-20 approval spender, == VaultKernel.assets() (checked before use)
    note_tree: str
    nullifier_set: str
    deploy_block: int
    weth: str
    usdc: str
    zk_keys: str  # "ceremony" | "dev" — which proving keys the chain's verifiers accept
    mainnet: bool
    admin_only: bool = False

    def token(self, asset: str) -> tuple[str, bool]:
        """(ERC-20 the note holds, native?) for an asset symbol or address."""
        a = (asset or "").strip()
        sym = a.upper()
        if sym == "ETH" or a.lower() in (NATIVE.lower(), "0x" + "0" * 40):
            return self.weth, True
        if sym == "WETH" or a.lower() == self.weth.lower():
            return self.weth, False
        if sym == "USDC" or a.lower() == self.usdc.lower():
            return self.usdc, False
        raise BadRequest(f"Unsupported asset '{asset}' on chain {self.chain_id}; use ETH, WETH or USDC.")


CHAINS: dict[int, V5Chain] = {
    8453: V5Chain(
        8453, "Base",
        vault_kernel="0x240c7066a5ac7628bfC18446115B7673CEe9A35f",
        compliance_hub="0x611503a87f70bF8fc9e0CCED3227682F6119A753",
        asset_adapter="0xc76FAdB7De5b5a0238a020e137A61B8d17328b43",
        note_tree="0x94dd1A6D2Dce713A42EC784880506E77AC37c174",
        nullifier_set="0x000725A49607450E3Ca94629Cf9df2e77CCE6d0E",
        deploy_block=50912919,
        weth="0x4200000000000000000000000000000000000006",
        usdc="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        zk_keys="ceremony", mainnet=True,
    ),
    42161: V5Chain(
        42161, "Arbitrum One",
        vault_kernel="0x9Bd05D63F48F2d486D45cD549BDb4F635F90348e",
        compliance_hub="0xb4dA47B1d5239F81d95D67b1015601201b99727a",
        asset_adapter="0xc59bfB9914140B7dCEaFc0cddA44e9038068310F",
        note_tree="0xe0E802A98c1b8f1b40796d192a5b950f61E64E42",
        nullifier_set="0xd1d5467d1aE4A52D22F2436Ca344930206b861A8",
        deploy_block=509682895,
        weth="0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        usdc="0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        zk_keys="ceremony", mainnet=True,
    ),
    # v5 stack of 2026-09-05, not the retired 0x50Db1b65 kernel. Its allowed ERC-20 is the stack's
    # test AssetToken, so that is what `usdc` points at. Admin-only (dev keys).
    11155111: V5Chain(
        11155111, "Ethereum Sepolia",
        vault_kernel="0x586dFaa329D71de7368617C9f00395C040bCf84a",
        compliance_hub="0x8Dc981a93B0cfffFC4a368F4010f7581E7806D62",
        asset_adapter="0x9A6BFA43930a22c6c8a3965A113C6CAd484C9e1b",
        note_tree="0x8Ba92c75F49C5B35996dDbdAc399BD4ae30CD394",
        nullifier_set="0x0E0c55eB838E079E88F73a50950FE94319E9bF92",
        deploy_block=11635625,
        weth="0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
        usdc="0xf08770c1C2970243768c6c082C91F69D8C3bd775",
        zk_keys="dev", mainnet=False, admin_only=True,
    ),
}


def chain(chain_id: int) -> V5Chain:
    c = CHAINS.get(int(chain_id))
    if not c:
        raise BadRequest(f"Siphon v5 is not deployed on chain {chain_id}; supported: {sorted(CHAINS)}.")
    return c


def is_admin_key(request) -> bool:
    return getattr(request.state, "api_key_id", None) in set(get_settings().v5_admin_api_key_ids)


def devnet_only(request) -> bool:
    """A free Devnet key: Solana Devnet (900002) and nothing else."""
    return bool(getattr(request.state, "devnet_only", False))


def chain_for(request, chain_id: int) -> V5Chain:
    """`chain()` plus access: admin-only chains (Sepolia) are refused to ordinary API keys, and every
    EVM chain to a free Devnet key."""
    if devnet_only(request):
        raise Forbidden("This is a free Solana Devnet key; it only works with chain_id 900002.")
    c = chain(chain_id)
    if c.admin_only and not is_admin_key(request):
        raise Forbidden(f"{c.name} is available to Siphon operators only.")
    return c


def access(request, chain_id) -> bool:
    """Check the caller may use `chain_id`; True for Solana Devnet, which has its own lane
    (services/solana_devnet), False for a v5 EVM chain (raises like `chain_for` otherwise)."""
    from app.services import solana_devnet

    if solana_devnet.is_solana(chain_id):
        return True
    chain_for(request, int(chain_id))
    return False


# ── per-chain downstreams ─────────────────────────────────────────────────────────────────────


def _own(chain_id: int, *names: str) -> tuple[str, ...]:
    """Base reads the unsuffixed settings; every other chain ONLY its own `<name>_<chainId>`."""
    s = get_settings()
    suffix = "" if int(chain_id) == 8453 else f"_{int(chain_id)}"
    return tuple(getattr(s, f"{n}{suffix}", "") or "" for n in names)


@lru_cache
def executor(chain_id: int) -> ExecutorClient:
    url, token = _own(chain_id, "executor_url", "executor_api_token")
    if not url:
        raise DownstreamUnavailable(f"No executor is configured for chain {chain_id}.")
    return ExecutorClient(base_url=url, api_token=token or None)


class AspClient(DownstreamClient):
    """The chain's ASP. Screen token on reads/screening, postman token on admission."""

    def __init__(self, base_url: str, *, screen_token: str, postman_token: str, transport=None):
        super().__init__(base_url, transport=transport)
        self._screen = screen_token
        self._postman = postman_token

    def _auth(self, token: str, caller: str | None = None) -> dict[str, str]:
        if not token:
            raise DownstreamUnavailable("Compliance service is not configured for this chain.")
        h = {"Authorization": f"Bearer {token}"}
        if caller:
            # The ASP sees one gateway IP; without this every tenant shares one rate bucket (G-7).
            h["X-Siphon-Caller"] = caller.lower()
        return h

    def _as_client_error(self, resp):
        # 402 is the ASP's fee paywall and 429 its own limiter — neither is the caller's bad input (G-9).
        if resp.status_code == 402:
            return ComplianceFeeRequired(
                "This wallet has not paid its compliance fee on this chain. See GET /v1/compliance-fee."
            )
        if resp.status_code == 429:
            return AspUnavailable("The compliance service is rate limited; retry shortly.")
        return super()._as_client_error(resp)

    def screen(self, body: dict) -> dict:
        return self._request("POST", "/screen", json=body, headers=self._auth(self._screen, body.get("depositor")))

    def admit(self, body: dict) -> dict:
        # The production Caddy path drops Authorization for this upstream; the ASP also accepts its
        # scoped header (same reason as siphon-app aspPostmanProxyHeaders).
        h = self._auth(self._postman)
        h["X-Asp-Postman-Token"] = self._postman
        return self._request("POST", "/set/admit", json=body, headers=h)

    def set_read(self, what: str, params: dict, caller: str | None = None) -> dict:
        return self._request("GET", f"/set/{what}", params=params, headers=self._auth(self._screen, caller))

    def solana_leaves(self) -> dict:
        """solasp's indexed NoteTree leaves for Solana Devnet (503 until contiguous with the chain)."""
        return self._request("GET", "/solana/state/leaves", params={"chainId": 900002}, headers=self._auth(self._screen))

    def fee_check(self, params: dict) -> dict:
        return self._request("GET", "/compliance-fee/check", params=params, headers=self._auth(self._screen, params.get("wallet")))

    def fee_verify(self, body: dict) -> dict:
        return self._request("POST", "/compliance-fee/verify", json=body, headers=self._auth(self._screen, body.get("wallet")))


@lru_cache
def asp(chain_id: int) -> AspClient:
    url, screen, postman = _own(chain_id, "asp_url", "asp_screen_token", "asp_postman_token")
    if not url:
        raise AspUnavailable(f"No compliance service is configured for chain {chain_id}.")
    return AspClient(url, screen_token=screen, postman_token=postman)


@lru_cache
def indexer(chain_id: int) -> DownstreamClient:
    s = get_settings()
    url = {8453: s.v5_indexer_url_8453, 42161: s.v5_indexer_url_42161, 11155111: s.v5_indexer_url_11155111}.get(int(chain_id), "")
    if not url:
        raise DownstreamUnavailable(f"No v5 indexer is configured for chain {chain_id}.")
    return DownstreamClient(url)

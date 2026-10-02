"""Public v5 chain state the SDK proves against, and the per-wallet compliance fee.

None of these routes ever sees a note secret. State leaves and compliance paths are the public
inputs a client needs to build its own proofs (@siphon/sdk-ts `V5DataSource`); the ASP tokens that
unlock them stay here.
"""
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from app.deps.api_key import verify_api_key
from app.deps.rate_limit import rate_limit
from app.deps.wallet_sig import verify_wallet_intent_or_sandbox, verify_wallet_sig_or_sandbox
from app.errors import AspUnavailable, BadRequest, CompliancePending, Forbidden, GatewayError, NotFound
from app.schemas.common import StrictModel
from app.schemas.errors_openapi import COMMON_ERRORS, WRITE_ERRORS
from app.services import sandbox, solana_devnet
from app.services import unsigned_transaction_service as uts
from app.services.v5_chains import CHAINS, access, asp, devnet_only, indexer, is_admin_key

router = APIRouter(prefix="/v1", tags=["Chains"])

_LABEL = r"^[0-9]{1,78}$"


class ChainView(BaseModel):
    chain_id: int
    name: str
    mainnet: bool
    vault_kernel: str
    compliance_hub: str
    note_tree: str
    nullifier_set: str
    deploy_block: int
    weth: str
    usdc: str
    asset_adapter: str = Field(description="ERC-20 deposit approval spender (VaultKernel.assets()).")
    zk_keys: str = Field(description="Proving-key set the chain's verifiers accept: ceremony or dev.")


class SolanaChainView(BaseModel):
    chain_id: int
    name: str
    mainnet: bool
    family: str = Field(description="Always solana.")
    program_id: str = Field(description="The Siphon ZK vault program.")
    vault: str = Field(description="Vault PDA (holds deposits; seeds siphon-vault-v1).")
    note_tree: str
    compliance: str = Field(description="Compliance PDA holding the admitted and revoked roots.")
    usdc: str
    wsol: str
    zk_keys: str = Field(description="Proving-key set the program's verifiers accept: dev.")


class ChainList(BaseModel):
    chains: list[ChainView | SolanaChainView]


@router.get("/chains", operation_id="listChains", summary="Siphon deployments", response_model=ChainList, responses=COMMON_ERRORS)
async def list_chains(request: Request, _key=Depends(verify_api_key), _rl=Depends(rate_limit("read"))) -> ChainList:
    admin = is_admin_key(request)
    evm = [] if devnet_only(request) else [
        ChainView(**{k: v for k, v in c.__dict__.items() if k != "admin_only"})
        for c in CHAINS.values() if admin or not c.admin_only
    ]
    return ChainList(chains=[*evm, SolanaChainView(**solana_devnet.chain_view())])


class VaultState(BaseModel):
    """Live Solana Devnet vault state — what a client needs to build a deposit commitment."""
    chain_id: int
    program_version: int
    deposit_nonce: int = Field(description="The nonce the NEXT deposit's label uses.")
    deposits_paused: bool
    allowed_mint: str
    scope_id: str = Field(description="vault_scope_id, decimal: label = P2(P3(3, scope_id, deposit_nonce), user_salt).")
    leaf_count: int
    state_root: str
    admitted_root: str
    revoked_root: str
    settlement_wallet: str | None = Field(default=None, description="Payee for order spends (the executor's settlement wallet).")
    meteora_pool: str | None = None


@router.get(
    "/chains/{chain_id}/vault",
    operation_id="getVaultState",
    summary="Live Solana Devnet vault state (deposit nonce, roots, settlement wallet)",
    response_model=VaultState,
    responses=COMMON_ERRORS,
)
async def vault_state(request: Request, chain_id: int, _key=Depends(verify_api_key), _rl=Depends(rate_limit("read"))) -> VaultState:
    if not access(request, chain_id):
        raise BadRequest("Live vault state is served for Solana Devnet (900002); EVM chains read their contracts.")
    settlement = {}
    try:
        from app.services.v5_chains import executor

        settlement = executor(chain_id)._request("GET", "/solana/settlement")
    except GatewayError:
        pass  # orders need it; deposits and payouts do not
    return VaultState(chain_id=chain_id, **solana_devnet.vault_state(),
                      settlement_wallet=settlement.get("pubkey"), meteora_pool=settlement.get("meteoraPool"))


class StateLeaves(BaseModel):
    chain_id: int
    from_index: int
    total_count: int
    tip_root: str
    leaves: list[str] = Field(description="NoteTree commitments in leaf order.")


@router.get(
    "/chains/{chain_id}/state-leaves",
    operation_id="getStateLeaves",
    summary="NoteTree leaves, for building state inclusion paths",
    response_model=StateLeaves,
    responses=COMMON_ERRORS,
)
async def state_leaves(
    request: Request,
    chain_id: int,
    from_index: int = Query(default=0, ge=0),
    limit: int = Query(default=1000, ge=1, le=5000),
    _key=Depends(verify_api_key),
    _rl=Depends(rate_limit("read")),
) -> StateLeaves:
    if access(request, chain_id):
        r = asp(chain_id).solana_leaves()
        leaves = [str(x) for x in r.get("leaves", [])]
        return StateLeaves(chain_id=chain_id, from_index=from_index, total_count=int(r.get("leafCount", len(leaves))),
                           tip_root=str(r.get("root", "0")), leaves=leaves[from_index:from_index + limit])
    r = indexer(chain_id)._request("GET", "/state/leaves", params={"chainId": chain_id, "fromIndex": from_index, "limit": limit})
    if not r.get("available", True):
        raise CompliancePending(str(r.get("reason") or "State leaves are not available yet; retry shortly."))
    return StateLeaves(
        chain_id=chain_id,
        from_index=int(r.get("fromIndex", from_index)),
        total_count=int(r.get("totalCount", 0)),
        tip_root=str(r.get("tipRoot", "0")),
        leaves=[str(x) for x in r.get("leaves", [])],
    )


class InputCompliance(BaseModel):
    inLabel: str
    admittedLeafIndex: int
    admittedPathElements: list[str]
    admittedPathIndices: list[int]
    revokedSmtPathElements: list[str]
    revokedSmtPathIndices: list[int]
    revokedSmtLeaf: str


class ComplianceWitness(BaseModel):
    """Exactly @siphon/sdk-ts `ComplianceWitness`."""
    admittedRoot: str
    revokedRoot: str
    inputs: list[InputCompliance]


def _nums(x) -> list:
    return list(x) if isinstance(x, list) else []


@router.get(
    "/chains/{chain_id}/compliance/witness",
    operation_id="getComplianceWitness",
    summary="ASP inclusion + revoked-SMT paths for a spend's labels",
    response_model=ComplianceWitness,
    responses=COMMON_ERRORS,
)
async def compliance_witness(
    request: Request,
    chain_id: int,
    labels: list[str] = Query(min_length=1, max_length=6, description="Note labels, in the spend's input order."),
    require_admitted: bool = Query(default=True, description="false only for RAGEQUIT, which proves no admission."),
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_sig_or_sandbox),
    _rl=Depends(rate_limit("read")),
) -> ComplianceWitness:
    """Wallet-signed, like the dapp's proxy: admission state is about someone's deposits (G-6)."""
    import re

    solana = access(request, chain_id)
    if sandbox.is_sandbox_request(request):
        raise Forbidden("Compliance paths are live-chain data; sandbox keys cannot read them.")
    if any(not re.fullmatch(_LABEL, l) for l in labels):
        raise BadRequest("labels must be decimal field elements.")
    client = asp(chain_id)
    # Roots before AND after the paths: an admission landing mid-read would pair paths with a root
    # they do not open to, and that only shows up as ProofFailed after proving (G-11).
    before = client.set_read("root", {"chainId": chain_id}, wallet)
    inputs = []
    for label in labels:
        try:
            admitted = client.set_read("path", {"label": label, "chainId": chain_id}, wallet)
        except NotFound:
            admitted = {"found": False}  # solasp answers 404 not_member instead of found:false
        smt = client.set_read("smt-path", {"label": label, "chainId": chain_id}, wallet)
        found = admitted.get("found", True if admitted.get("pathElements") is not None else None)
        if found not in (True, False):
            raise AspUnavailable("The compliance service returned a malformed admission path.")
        if not found and require_admitted:
            raise CompliancePending(f"Label {label} is not admitted yet (admission runs in ~5-minute batches).")
        depth = len(_nums(smt.get("pathElements")))
        if depth == 0:
            raise AspUnavailable("The compliance service returned an empty revocation path.")
        inputs.append(InputCompliance(
            inLabel=label,
            admittedLeafIndex=0 if not found else int(admitted.get("leafIndex") or 0),
            admittedPathElements=["0"] * depth if not found else [str(v) for v in _nums(admitted.get("pathElements"))],
            admittedPathIndices=[0] * depth if not found else [int(v) for v in _nums(admitted.get("pathIndices"))],
            revokedSmtPathElements=[str(v) for v in _nums(smt.get("pathElements"))],
            revokedSmtPathIndices=[int(v) for v in _nums(smt.get("pathIndices"))],
            revokedSmtLeaf=str(smt.get("claimedLeaf") or "0"),
        ))
    after = client.set_read("root", {"chainId": chain_id}, wallet)
    roots = (str(after.get("admittedRoot")), str(after.get("revokedRoot")))
    if roots != (str(before.get("admittedRoot")), str(before.get("revokedRoot"))):
        raise CompliancePending("The compliance roots moved while reading; retry.")
    try:
        on_chain = solana_devnet.compliance_roots() if solana else uts.hub_roots(chain_id)
    except Exception as exc:  # noqa: BLE001
        raise AspUnavailable("Could not read the ComplianceHub roots on-chain; retry shortly.") from exc
    if on_chain != roots:
        # The ASP is ahead of (or behind) what the hub accepts; a proof over these roots would
        # revert. New roots publish within minutes.
        raise CompliancePending("New compliance roots are being published on-chain; retry in a minute.")
    return ComplianceWitness(admittedRoot=roots[0], revokedRoot=roots[1], inputs=inputs)


class LabelStatus(BaseModel):
    label: str
    admitted: bool
    revoked: bool


@router.get(
    "/chains/{chain_id}/compliance/labels/{label}",
    operation_id="getLabelStatus",
    summary="Has a deposit's label been admitted (spendable) or revoked (ragequit only)?",
    response_model=LabelStatus,
    responses=COMMON_ERRORS,
)
async def label_status(
    request: Request,
    chain_id: int,
    label: str,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_sig_or_sandbox),
    _rl=Depends(rate_limit("read")),
) -> LabelStatus:
    import re

    access(request, chain_id)
    if sandbox.is_sandbox_request(request):
        raise Forbidden("Label status is live-chain data; sandbox keys cannot read it.")
    if not re.fullmatch(_LABEL, label):
        raise BadRequest("label must be a decimal field element.")
    r = asp(chain_id).set_read("member", {"label": label, "chainId": chain_id}, wallet)
    return LabelStatus(label=label, admitted=bool(r.get("admitted")), revoked=bool(r.get("revoked")))


# ── per-wallet compliance fee ───────────────────────────────────────────────────────────────


class ComplianceFee(BaseModel):
    chain_id: int
    wallet: str
    paid: bool
    vault: str | None = Field(default=None, description="Pay the fee here: a plain ETH transfer from the wallet.")
    fee_wei: str | None = None
    product: str


@router.get(
    "/compliance-fee",
    operation_id="getComplianceFee",
    summary="Has the signing wallet paid its yearly compliance fee on this chain?",
    response_model=ComplianceFee,
    responses=COMMON_ERRORS,
)
async def compliance_fee(
    request: Request,
    chain_id: int = Query(),
    product: str = Query(default="kyt_year_v1", pattern=r"^[a-z0-9_]{1,40}$"),
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_sig_or_sandbox),
    _rl=Depends(rate_limit("read")),
) -> ComplianceFee:
    # Wallet-signed, not just keyed: whether an address paid for KYT is about that person, so only
    # the wallet itself may ask.
    if access(request, chain_id):
        # Solana Devnet has no fee rail: solasp screens Solana wallets against its lists only.
        return ComplianceFee(chain_id=chain_id, wallet=wallet, paid=True, product=product)
    if sandbox.is_sandbox_request(request):
        return ComplianceFee(chain_id=chain_id, wallet=wallet, paid=True, product=product)
    r = asp(chain_id).fee_check({"wallet": wallet.lower(), "chainId": chain_id, "product": product})
    return ComplianceFee(
        chain_id=chain_id,
        wallet=wallet,
        paid=bool(r.get("paid")),
        vault=r.get("vault"),
        fee_wei=str(r["feeWei"]) if r.get("feeWei") is not None else None,
        product=product,
    )


class ComplianceFeeVerifyRequest(StrictModel):
    chain_id: int
    tx_hash: str = Field(pattern=r"^0x[0-9a-fA-F]{64}$", description="The fee payment, sent FROM the signing wallet.")
    product: str = Field(default="kyt_year_v1", pattern=r"^[a-z0-9_]{1,40}$")


@router.post(
    "/compliance-fee/verify",
    operation_id="verifyComplianceFee",
    summary="Record a compliance-fee payment (needs 2 confirmations; retry on 409)",
    response_model=ComplianceFee,
    responses=WRITE_ERRORS,
)
async def verify_compliance_fee(
    body: ComplianceFeeVerifyRequest,
    request: Request,
    _key=Depends(verify_api_key),
    wallet: str = Depends(verify_wallet_intent_or_sandbox),
    _rl=Depends(rate_limit("validate")),
) -> ComplianceFee:
    if access(request, body.chain_id):
        raise BadRequest("Solana Devnet has no compliance fee to verify.")
    if sandbox.is_sandbox_request(request):
        return ComplianceFee(chain_id=body.chain_id, wallet=wallet, paid=True, product=body.product)
    try:
        asp(body.chain_id).fee_verify({"wallet": wallet.lower(), "txHash": body.tx_hash, "chainId": body.chain_id, "product": body.product})
    except GatewayError as exc:
        # Same split as the dapp (complianceFee.ts): "not confirmed yet" is retryable, the rest is
        # a real rejection of this payment.
        if re_not_yet(str(exc.detail)):
            raise CompliancePending("The fee payment is not confirmed yet (2 blocks); retry in a few seconds.") from exc
        raise
    return ComplianceFee(chain_id=body.chain_id, wallet=wallet, paid=True, product=body.product)


def re_not_yet(text: str) -> bool:
    import re

    return bool(re.search(r"confirmations|not (yet )?(mined|found)|pending", text, re.I))


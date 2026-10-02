"""Build unsigned v5 (VaultKernel) transactions without acquiring spend authority.

Deposits: the client makes the note secrets (precommitment + userSalt); Siphon returns calldata for
the user's wallet. Spends: the client proves locally (@siphon/sdk-ts); Siphon checks the bundle's
public limbs against what the business asked for and returns — or relays — `VaultKernel.spend`.
Mirrors siphon-app src/lib/v3/depositV3.ts and trade-executor evm_executor.vault_kernel_spend.
"""
from __future__ import annotations

import hashlib
import re

from web3 import Web3
from web3.exceptions import ContractLogicError

from app.errors import BadRequest, Conflict, DownstreamUnavailable
from app.services.v5_chains import PROGRAM_VERSION, V5Chain, chain as v5_chain

FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617

KERNEL_ABI = [
    {"type": "function", "name": "deposit", "stateMutability": "nonpayable",
     "inputs": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"},
                {"name": "userSalt", "type": "uint256"}, {"name": "precommitment", "type": "uint256"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "depositNative", "stateMutability": "payable",
     "inputs": [{"name": "userSalt", "type": "uint256"}, {"name": "precommitment", "type": "uint256"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "assets", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "spend", "stateMutability": "nonpayable", "outputs": [],
     "inputs": [{"name": "publicInputs", "type": "uint256[25]"}, {"name": "proof", "type": "uint256[8]"},
                {"name": "compliancePublicInputs", "type": "uint256[5]"}, {"name": "complianceProof", "type": "uint256[8]"},
                {"name": "extra", "type": "tuple", "components": [
                    {"name": "rawPayee", "type": "bytes"}, {"name": "splitCommitments", "type": "uint256[8]"}]}]},
    # depositor NOT indexed, token indexed — a wrong flag decodes nothing (see depositV3.ts).
    {"type": "event", "name": "Deposited", "anonymous": False, "inputs": [
        {"name": "depositor", "type": "address", "indexed": False},
        {"name": "token", "type": "address", "indexed": True},
        {"name": "amount", "type": "uint256", "indexed": False},
        {"name": "commitment", "type": "uint256", "indexed": False},
        {"name": "depositNonce", "type": "uint256", "indexed": False},
        {"name": "stateRootAfter", "type": "uint256", "indexed": False}]},
]
ERC20_ABI = [
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"type": "function", "name": "allowance", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
]

_kernel = Web3().eth.contract(abi=KERNEL_ABI)
_erc20 = Web3().eth.contract(abi=ERC20_ABI)


def _field(value, name: str) -> int:
    """A BN254 scalar given as a DECIMAL string. Hex, signs and whitespace are refused: a value the
    gateway reads one way and a downstream reads another is how deposits get stranded (G-2)."""
    text = str(value)
    # ASCII only: str.isdigit() also accepts e.g. "٣", which int() silently reads as 3.
    if not re.fullmatch(r"[0-9]{1,78}", text):
        raise BadRequest(f"{name} must be a decimal integer.")
    v = int(text)
    if not 0 <= v < FIELD:
        raise BadRequest(f"{name} is outside the BN254 scalar field.")
    return v


def transaction_data_sha256(data: str) -> str:
    normalized = (data or "").lower().removeprefix("0x")
    try:
        raw = bytes.fromhex(normalized)
    except ValueError:
        raise BadRequest("Transaction data must be 0x-prefixed hexadecimal.")
    return hashlib.sha256(raw).hexdigest()


def _w3(chain_id: int) -> Web3:
    from app.services.confirmations import get_rpc_url

    url = get_rpc_url(chain_id)
    if not url:
        raise DownstreamUnavailable(f"No RPC configured for chain {chain_id}.")
    return Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 15}))


# ── deposits ──────────────────────────────────────────────────────────────────────────────────


def deposit_plan(*, chain_id: int, asset: str, amount_minor: int, wallet: str,
                 precommitment: str, user_salt: str) -> dict:
    """What the wallet must sign next, plus the commitment the kernel would mint for it.

    ERC-20s approve the kernel's ASSET ADAPTER (`VaultKernel.assets()`), not the kernel. Until that
    allowance is visible the deposit cannot even be simulated, so the plan is `approve` first and
    the client calls again. The commitment comes from simulating the exact deposit call — it is
    what the ASP screens and what the deposit watcher later matches.
    """
    if amount_minor <= 0:
        raise BadRequest("amount_minor must be positive.")
    if not Web3.is_address(wallet):
        raise BadRequest("wallet must be an EVM address.")
    c = v5_chain(chain_id)
    token, native = c.token(asset)
    salt = _field(user_salt, "user_salt")
    pre = _field(precommitment, "precommitment")
    if salt == 0:
        raise BadRequest("user_salt must be non-zero.")
    kernel = Web3.to_checksum_address(c.vault_kernel)
    sender = Web3.to_checksum_address(wallet)
    w3 = _w3(chain_id)

    if native:
        data = _kernel.encode_abi("depositNative", [salt, pre])
        tx = {"chain_id": chain_id, "to": kernel, "data": data, "value": str(amount_minor), "purpose": "deposit"}
    else:
        try:
            adapter = Web3.to_checksum_address(w3.eth.call({"to": kernel, "data": _kernel.encode_abi("assets", [])})[-20:])
            allowance = int.from_bytes(w3.eth.call({"to": token, "data": _erc20.encode_abi("allowance", [sender, adapter])}), "big")
        except Exception as exc:
            raise DownstreamUnavailable("Could not read the vault's allowance on-chain; retry shortly.") from exc
        if adapter.lower() != c.asset_adapter.lower():
            # The spender is pinned: an RPC that lies about assets() must not redirect the approval.
            raise DownstreamUnavailable("The chain reported an unexpected asset adapter; refusing to build an approval.")
        if allowance < amount_minor:
            return {"phase": "approve", "commitment": None, "transactions": [{
                "chain_id": chain_id, "to": Web3.to_checksum_address(token),
                "data": _erc20.encode_abi("approve", [adapter, amount_minor]),
                "value": "0", "purpose": "approve_deposit",
            }]}
        data = _kernel.encode_abi("deposit", [Web3.to_checksum_address(token), amount_minor, salt, pre])
        tx = {"chain_id": chain_id, "to": kernel, "data": data, "value": "0", "purpose": "deposit"}

    try:
        out = w3.eth.call({"from": sender, "to": kernel, "data": tx["data"], "value": int(tx["value"])})
    except ContractLogicError as exc:
        # A revert is the deposit itself failing (balance, paused asset, bad salt) — say so before
        # the user pays gas for the same revert. Only the revert reason crosses this boundary.
        reason = str(getattr(exc, "message", "") or "execution reverted")[:160]
        raise Conflict(f"The deposit would revert on-chain: {reason}") from exc
    except Exception as exc:
        # Transport errors carry the RPC URL (and its API key); never echo them (G-3).
        raise DownstreamUnavailable("Could not simulate the deposit on-chain; retry shortly.") from exc
    return {"phase": "deposit", "commitment": str(int.from_bytes(out[-32:], "big")), "transactions": [tx]}


def parse_deposited(chain_id: int, tx_hash: str) -> dict | None:
    """The kernel's Deposited event in `tx_hash`, or None if it has none."""
    c = v5_chain(chain_id)
    w3 = _w3(chain_id)
    receipt = w3.eth.get_transaction_receipt(tx_hash)
    event = _kernel.events.Deposited()
    for log in receipt.get("logs", []):
        if str(log.get("address", "")).lower() != c.vault_kernel.lower():
            continue
        try:
            args = event.process_log(log)["args"]
        except Exception:
            continue
        user_salt = None
        try:
            # userSalt is public deposit calldata; the ASP derives the label from it + depositNonce.
            fn, fargs = _kernel.decode_function_input(w3.eth.get_transaction(tx_hash).get("input"))
            if fn.fn_name in ("deposit", "depositNative"):
                user_salt = str(fargs["userSalt"])
        except Exception:
            pass
        return {"depositor": args["depositor"], "token": args["token"], "amount": int(args["amount"]),
                "commitment": str(args["commitment"]), "deposit_nonce": int(args["depositNonce"]),
                "from": receipt.get("from"), "status": receipt.get("status"), "user_salt": user_salt}
    return None


def nullifier_used(chain_id: int, nullifier_hash: int) -> bool:
    """On-chain truth for "did this spend happen", independent of any relayer reply."""
    c = v5_chain(chain_id)
    data = "0x" + Web3.keccak(text="isUsed(uint256)")[:4].hex() + nullifier_hash.to_bytes(32, "big").hex()
    out = _w3(chain_id).eth.call({"to": Web3.to_checksum_address(c.nullifier_set), "data": data})
    return int.from_bytes(out[-32:], "big") == 1


# ── spends ────────────────────────────────────────────────────────────────────────────────────


def _asset_id(token: str) -> int:
    return int(token, 16)


def validate_withdraw_bundle(c: V5Chain, bundle: dict, *, asset: str, amount_minor: int, recipient: str) -> None:
    """The bundle must pay exactly what the business asked for, where it asked.

    The proof itself is checked by the kernel; what the gateway enforces is that its policy
    decision (amount, asset, recipient) is the one the proof commits to — otherwise a client
    could have policy approve 10 USDC and submit a proof for 10,000.
    """
    normalize_bundle(bundle)
    pub = bundle["public_inputs"]
    if int(pub[0]) != 0:
        raise BadRequest("Payouts take a WITHDRAW proof (public_inputs[0] == 0).")
    if int(pub[16]) != PROGRAM_VERSION:
        raise BadRequest(f"public_inputs[16] must be program version {PROGRAM_VERSION}.")
    token, _ = c.token(asset)
    if int(pub[17]) != _asset_id(token):
        raise BadRequest("The proof's asset (public_inputs[17]) does not match `asset`.")
    if int(pub[5]) != amount_minor:
        raise BadRequest("The proof's payout (public_inputs[5]) does not match amount_minor.")
    raw = (bundle.get("extra") or {}).get("rawPayee", "")
    if not Web3.is_address(recipient) or str(raw).lower() != recipient.lower():
        raise BadRequest("extra.rawPayee must equal `recipient` (the proof binds the payee to it).")


def normalize_bundle(bundle: dict) -> dict:
    """Every limb a decimal field element (G-10): malformed values are a 400, not a 500, and what
    the gateway checks is byte-for-byte what it forwards."""
    for key, width in (("public_inputs", 25), ("proof", 8), ("compliancePublicInputs", 5), ("complianceProof", 8)):
        values = bundle.get(key) or []
        if len(values) != width:
            raise BadRequest(f"{key} must have {width} values.")
        bundle[key] = [str(_field(v, f"{key}[{i}]")) for i, v in enumerate(values)]
    raw = str((bundle.get("extra") or {}).get("rawPayee", ""))
    if raw and not Web3.is_address(raw):
        raise BadRequest("extra.rawPayee must be a 20-byte address.")
    return bundle


def spend_transaction(chain_id: int, bundle: dict) -> dict:
    """`VaultKernel.spend` for an independent relayer. spend() is permissionless."""
    c = v5_chain(chain_id)
    extra = bundle.get("extra") or {}
    raw = extra.get("rawPayee") or ""
    splits = [int(x) for x in (extra.get("splitCommitments") or [])]
    splits += [0] * (8 - len(splits))
    data = _kernel.encode_abi("spend", [
        [int(x) for x in bundle["public_inputs"]],
        [int(x) for x in bundle["proof"]],
        [int(x) for x in bundle["compliancePublicInputs"]],
        [int(x) for x in bundle["complianceProof"]],
        (bytes.fromhex(raw.removeprefix("0x")) if raw else b"", splits[:8]),
    ])
    return {"chain_id": chain_id, "to": Web3.to_checksum_address(c.vault_kernel), "data": data, "value": "0", "purpose": "payout"}


def hub_roots(chain_id: int) -> tuple[str, str]:
    """(admittedRoot, revokedRoot) the ComplianceHub accepts right now."""
    c = v5_chain(chain_id)
    w3 = _w3(chain_id)
    hub = Web3.to_checksum_address(c.compliance_hub)
    out = []
    for sig in ("admittedRoot()", "revokedRoot()"):
        raw = w3.eth.call({"to": hub, "data": "0x" + Web3.keccak(text=sig)[:4].hex()})
        out.append(str(int.from_bytes(raw[-32:], "big")))
    return out[0], out[1]

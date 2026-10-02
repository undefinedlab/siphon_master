"""Solana Devnet (chain 900002): Siphon's ZK vault program and the services around it.

The same protocol as v5 on EVM — client-held notes, ASP-admitted labels, 25-limb Groth16 spends —
on an Anchor program instead of a VaultKernel. Layouts mirror siphon-contracts-v2
`solana/programs/siphon-vault-zk` and siphon-app `solanaVaultZk.ts`; tests/unit/test_solana_devnet.py
pins them. Nothing here holds a note secret: deposits arrive as precommitment + commitment, spends
as public limbs + a proof.
"""
from __future__ import annotations

import base64
import hashlib
import re
import secrets

import base58
import httpx
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction

from app.config import get_settings
from app.errors import BadRequest, Conflict, DownstreamUnavailable

CHAIN_ID = 900002
NAME = "Solana Devnet"
FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617
PROGRAM_VERSION = 5
WSOL = Pubkey.from_string("So11111111111111111111111111111111111111112")
TOKEN_PROGRAM = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ATA_PROGRAM = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
SYSTEM_PROGRAM = Pubkey.from_string("11111111111111111111111111111111")
WITHDRAW_CIRCUITS = range(0, 6)  # withdraw1..6 → VK slots 0..5
SPLIT_CIRCUIT = 12
_SIG = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{64,90}$")


def is_solana(chain_id) -> bool:
    try:
        return int(chain_id) == CHAIN_ID
    except (TypeError, ValueError):
        return False


def program_id() -> Pubkey:
    return Pubkey.from_string(get_settings().solana_program_id)


def usdc_mint() -> Pubkey:
    return Pubkey.from_string(get_settings().solana_usdc_mint)


def pda(*seeds: bytes) -> Pubkey:
    return Pubkey.find_program_address(list(seeds), program_id())[0]


def vault_pda() -> Pubkey:
    return pda(b"siphon-vault-v1")


def tree_pda() -> Pubkey:
    return pda(b"siphon-tree-v1")


def compliance_pda() -> Pubkey:
    return pda(b"siphon-compliance-v1")


def ata(owner: Pubkey, mint: Pubkey) -> Pubkey:
    return Pubkey.find_program_address([bytes(owner), bytes(TOKEN_PROGRAM), bytes(mint)], ATA_PROGRAM)[0]


def disc(name: str) -> bytes:
    return hashlib.sha256(f"global:{name}".encode()).digest()[:8]


def le32(value: int) -> bytes:
    return int(value).to_bytes(32, "little")


def from_le(raw: bytes) -> int:
    return int.from_bytes(raw, "little")


def pubkey(value: str, name: str) -> Pubkey:
    try:
        key = Pubkey.from_string(str(value).strip())
    except Exception:
        raise BadRequest(f"{name} must be a base58 Solana address.")
    return key


def field(value, name: str) -> int:
    """A BN254 scalar as a DECIMAL string (same rule as the EVM lane, G-2)."""
    text = str(value)
    if not re.fullmatch(r"[0-9]{1,78}", text):
        raise BadRequest(f"{name} must be a decimal integer.")
    v = int(text)
    if v >= FIELD:
        raise BadRequest(f"{name} is outside the BN254 scalar field.")
    return v


def asset_id(mint: Pubkey) -> int:
    """The circuit's asset id: the mint read big-endian, reduced into the field."""
    return int.from_bytes(bytes(mint), "big") % FIELD


def mint_for(asset: str) -> tuple[Pubkey, bool]:
    """(mint the note holds, deposited as native SOL?) for SOL or USDC."""
    sym = (asset or "").strip().upper()
    if sym == "SOL":
        return WSOL, True
    if sym == "USDC" or (asset or "").strip() == str(usdc_mint()):
        return usdc_mint(), False
    raise BadRequest(f"Unsupported asset '{asset}' on Solana Devnet; use SOL or USDC.")


# ── RPC ───────────────────────────────────────────────────────────────────────────────────────


def rpc(method: str, params: list):
    try:
        resp = httpx.post(get_settings().solana_devnet_rpc,
                          json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=15)
        body = resp.json()
    except Exception as exc:
        # The RPC URL can carry an API key; never echo transport errors.
        raise DownstreamUnavailable("The Solana RPC is unavailable; retry shortly.") from exc
    if body.get("error"):
        raise DownstreamUnavailable(f"Solana RPC {method} failed.")
    return body.get("result")


def account_data(key: Pubkey) -> bytes | None:
    value = (rpc("getAccountInfo", [str(key), {"encoding": "base64", "commitment": "confirmed"}]) or {}).get("value")
    return base64.b64decode(value["data"][0]) if value else None


def vault_state() -> dict:
    """VaultAccount (Borsh): version 41..73, deposit_nonce 73, state_root 81..113, paused 113,
    allowed_mint 114..146, vault_scope_id 146..178."""
    vault = account_data(vault_pda())
    tree = account_data(tree_pda())
    comp = account_data(compliance_pda())
    if not vault or not tree or not comp:
        raise DownstreamUnavailable("The Solana Devnet vault is not initialized.")
    return {
        "program_version": from_le(vault[41:73]),
        "deposit_nonce": int.from_bytes(vault[73:81], "little"),
        "deposits_paused": bool(vault[113]),
        "allowed_mint": str(Pubkey.from_bytes(vault[114:146])),
        "scope_id": str(from_le(vault[146:178])),
        # TreeAccount (zero-copy): next_index u64 @16, root @24..56.
        "leaf_count": int.from_bytes(tree[16:24], "little"),
        "state_root": str(from_le(tree[24:56])),
        # ComplianceAccount: admitted @9..41, revoked @41..73.
        "admitted_root": str(from_le(comp[9:41])),
        "revoked_root": str(from_le(comp[41:73])),
    }


def compliance_roots() -> tuple[str, str]:
    comp = account_data(compliance_pda())
    if not comp:
        raise DownstreamUnavailable("The Solana Devnet compliance account is missing.")
    return str(from_le(comp[9:41])), str(from_le(comp[41:73]))


def nullifier_spent(nullifier_hash: int) -> bool:
    """A nullifier account exists exactly when the note is spent."""
    return account_data(pda(b"siphon-nf-v1", le32(nullifier_hash))) is not None


# ── deposits ──────────────────────────────────────────────────────────────────────────────────


def deposit_instruction(depositor: Pubkey, mint: Pubkey, amount: int, user_salt: int,
                        precommitment: int, commitment: int) -> Instruction:
    data = disc("deposit") + amount.to_bytes(8, "little") + le32(user_salt) + le32(precommitment) + le32(commitment)
    vault = vault_pda()
    metas = [
        (depositor, True, True), (vault, False, True), (tree_pda(), False, True), (mint, False, False),
        (ata(depositor, mint), False, True), (ata(vault, mint), False, True),
        (pda(b"siphon-leaf-v1", le32(commitment)), False, True),
        (TOKEN_PROGRAM, False, False), (ATA_PROGRAM, False, False), (SYSTEM_PROGRAM, False, False),
    ]
    return Instruction(program_id(), data, [AccountMeta(k, s, w) for k, s, w in metas])


def _wrap_sol(owner: Pubkey, lamports: int) -> list[Instruction]:
    """Create the owner's WSOL account (idempotent), fund it, sync — the deposit then spends it."""
    wsol = ata(owner, WSOL)
    create = Instruction(ATA_PROGRAM, bytes([1]), [
        AccountMeta(owner, True, True), AccountMeta(wsol, False, True), AccountMeta(owner, False, False),
        AccountMeta(WSOL, False, False), AccountMeta(SYSTEM_PROGRAM, False, False),
        AccountMeta(TOKEN_PROGRAM, False, False),
    ])
    fund = transfer(TransferParams(from_pubkey=owner, to_pubkey=wsol, lamports=lamports))
    sync = Instruction(TOKEN_PROGRAM, bytes([17]), [AccountMeta(wsol, False, True)])
    return [create, fund, sync]


def _simulate(tx: Transaction) -> None:
    out = rpc("simulateTransaction", [base64.b64encode(bytes(tx)).decode(),
                                      {"encoding": "base64", "sigVerify": False, "commitment": "confirmed"}])
    value = (out or {}).get("value") or {}
    if value.get("err") is not None:
        logs = [line for line in (value.get("logs") or []) if "Error" in line or "failed" in line]
        reason = (logs[-1] if logs else str(value["err"]))[:200]
        raise Conflict(f"The deposit would fail on-chain: {reason}")


def deposit_plan(*, asset: str, amount_minor: int, wallet: str, precommitment: str,
                 user_salt: str, commitment: str) -> dict:
    """An unsigned deposit transaction for the wallet, simulated first.

    The client computes the commitment (it needs the vault's current deposit_nonce, see
    GET /v1/chains/900002/vault); the program recomputes it and rejects a mismatch, so the
    simulation is the check. A deposit landing first moves the nonce: the client recomputes and
    calls again. The blockhash expires in ~60s — sign and send promptly.
    """
    if amount_minor <= 0:
        raise BadRequest("amount_minor must be positive.")
    owner = pubkey(wallet, "wallet")
    mint, native = mint_for(asset)
    salt = field(user_salt, "user_salt")
    if salt == 0:
        raise BadRequest("user_salt must be non-zero.")
    deposit = deposit_instruction(owner, mint, amount_minor, salt, field(precommitment, "precommitment"),
                                  field(commitment, "commitment"))
    ixs = (_wrap_sol(owner, amount_minor) if native else []) + [deposit]
    latest = (rpc("getLatestBlockhash", [{"commitment": "confirmed"}]) or {}).get("value") or {}
    try:
        blockhash = Hash.from_string(latest["blockhash"])
    except Exception as exc:
        raise DownstreamUnavailable("The Solana RPC returned no blockhash; retry shortly.") from exc
    tx = Transaction.new_unsigned(Message.new_with_blockhash(ixs, owner, blockhash))
    _simulate(tx)
    return {
        "transaction": base64.b64encode(bytes(tx)).decode(),
        "deposit_data_sha256": hashlib.sha256(bytes(deposit.data)).hexdigest(),
        "last_valid_block_height": latest.get("lastValidBlockHeight"),
    }


# ── submissions and settlement ────────────────────────────────────────────────────────────────


def valid_signature(sig: str) -> bool:
    if not _SIG.fullmatch(sig or ""):
        return False
    try:
        return len(base58.b58decode(sig)) == 64
    except Exception:
        return False


def validate_submitted_deposit(signature: str, *, wallet: str, expected_data_sha256: str) -> None:
    """Bind an operation to the exact deposit it returned: signed by the wallet, calling our
    program with the planned instruction data."""
    if not valid_signature(signature):
        raise BadRequest("tx_hash must be a base58 Solana transaction signature.")
    tx = rpc("getTransaction", [signature, {"encoding": "json", "commitment": "confirmed",
                                            "maxSupportedTransactionVersion": 0}])
    if not tx:
        raise Conflict("Transaction is not yet visible on Solana Devnet.")
    message = (tx.get("transaction") or {}).get("message") or {}
    keys = message.get("accountKeys") or []
    if not keys or keys[0] != wallet:
        raise Conflict("The transaction was not signed by the account wallet.")
    program = str(program_id())
    for ix in message.get("instructions") or []:
        idx = ix.get("programIdIndex")
        if idx is not None and idx < len(keys) and keys[idx] == program:
            if hashlib.sha256(base58.b58decode(ix.get("data") or "")).hexdigest() == expected_data_sha256:
                return
    raise Conflict("Transaction does not contain the authorized deposit instruction.")


def signature_state(signature: str) -> str | None:
    """'confirmed' once finalized, 'failed' if it errored, None while unknown or in flight."""
    value = ((rpc("getSignatureStatuses", [[signature], {"searchTransactionHistory": True}]) or {})
             .get("value") or [None])[0]
    if not value:
        return None
    if value.get("err") is not None:
        return "failed"
    return "confirmed" if value.get("confirmationStatus") == "finalized" else None


# ── spends ────────────────────────────────────────────────────────────────────────────────────


def spend_package(spend: dict, *, split_commitments: list[str] | None = None, asset: str | None = None,
                  amount_minor: int | None = None) -> dict:
    """Validate a client-proved withdraw (or split) and build the relayer package.

    The program checks the proof; the gateway checks that what it proves is what policy approved:
    a withdraw of exactly `amount_minor` of `asset`. The payee is bound on-chain (limb 15 against
    the recipient the relayer passes), so the recipient cannot be swapped either.
    """
    publics = [str(field(v, f"public_inputs[{i}]")) for i, v in enumerate(spend.get("public_inputs") or [])]
    if len(publics) != 25:
        raise BadRequest("public_inputs must have 25 values.")
    proof_hex = str(spend.get("proof_hex") or "").lower().removeprefix("0x")
    if not re.fullmatch(r"[0-9a-f]{512}", proof_hex):
        raise BadRequest("proof_hex must be the 256-byte Groth16 proof (A | B | C, big-endian).")
    circuit = int(spend.get("circuit_index", -1))
    count = int(publics[1])
    if not 1 <= count <= 6:
        raise BadRequest("public_inputs[1] (input count) must be 1..6.")
    if int(publics[16]) != PROGRAM_VERSION:
        raise BadRequest(f"public_inputs[16] must be program version {PROGRAM_VERSION}.")
    package = {
        "publics": publics,
        "proof_hex": proof_hex,
        "binder_hex": secrets.token_hex(32),
        # Derived, never taken from the client: the nullifier accounts the relayer creates.
        "nullifiers_hex": [le32(int(publics[9 + i])).hex() for i in range(count)],
        "circuit_index": circuit,
    }
    if split_commitments is not None:
        if int(publics[0]) != 3 or circuit != SPLIT_CIRCUIT or count != 1:
            raise BadRequest("A split takes a SPLIT proof (public_inputs[0] == 3, circuit_index 12, one input).")
        if len(split_commitments) != 8:
            raise BadRequest("split_commitments must have 8 values (0 for unused slots).")
        package["split_commitments_hex"] = [le32(field(c, f"split_commitments[{i}]")).hex()
                                            for i, c in enumerate(split_commitments)]
        return package
    if int(publics[0]) != 0:
        raise BadRequest("Payouts take a WITHDRAW proof (public_inputs[0] == 0).")
    if circuit not in WITHDRAW_CIRCUITS or circuit != count - 1:
        raise BadRequest("circuit_index must be the withdraw circuit for the input count (withdrawN → N-1).")
    mint, _ = mint_for(asset or "")
    if int(publics[17]) != asset_id(mint):
        raise BadRequest("The proof's asset (public_inputs[17]) does not match `asset`.")
    if int(publics[5]) != amount_minor:
        raise BadRequest("The proof's payout (public_inputs[5]) does not match amount_minor.")
    package["mint"] = str(mint)
    return package


def chain_view() -> dict:
    """Static deployment facts (no network): what /v1/chains lists for Solana Devnet."""
    return {
        "chain_id": CHAIN_ID,
        "name": NAME,
        "mainnet": False,
        "family": "solana",
        "program_id": str(program_id()),
        "vault": str(vault_pda()),
        "note_tree": str(tree_pda()),
        "compliance": str(compliance_pda()),
        "usdc": str(usdc_mint()),
        "wsol": str(WSOL),
        "zk_keys": "dev",
    }

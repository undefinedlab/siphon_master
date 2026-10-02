"""Solana vault runtime bindings for the trade executor.

Routes FHE-triggered spends to the solana-v1 logical path (commit publics →
Groth16 spend) once the on-chain program is deployed. Base/EVM paths are untouched.

Siphon-internal chain ids (must match siphon-app/src/lib/chains/registry.ts):
  900001 = solana-mainnet
  900002 = solana-devnet

Solana env is read locally so this module stays importable without full executor
config (NOTE_DB_URI etc.).
"""

from __future__ import annotations

import logging
import os
import base64
import hashlib
import json
import urllib.request
from typing import Any, Optional

logger = logging.getLogger(__name__)

SOLANA_MAINNET_CHAIN_ID = 900_001
SOLANA_DEVNET_CHAIN_ID = 900_002

SOLANA_CHAIN_IDS = {SOLANA_MAINNET_CHAIN_ID, SOLANA_DEVNET_CHAIN_ID}

SOLANA_NETWORK = os.getenv("SOLANA_NETWORK", "devnet")
# Devnet BPF MVP program id (siphon-vault-onchain). Override via SIPHON_PROGRAM_ID.
SIPHON_PROGRAM_ID = os.getenv(
    "SIPHON_PROGRAM_ID", "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj"
)


def _solana_rpc_url() -> str:
    helius = os.getenv("HELIUS_API_KEY")
    custom = os.getenv("SOLANA_RPC_URL")
    if custom:
        return custom
    if helius:
        network = "mainnet" if SOLANA_NETWORK == "mainnet-beta" else SOLANA_NETWORK
        return f"https://{network}.helius-rpc.com/?api-key={helius}"
    return "https://api.devnet.solana.com"


SOLANA_RPC_URL = _solana_rpc_url()


def is_solana_chain_id(chain_id: Any) -> bool:
    try:
        return int(chain_id) in SOLANA_CHAIN_IDS
    except (TypeError, ValueError):
        return False


def solana_chain_id_for_network(network: Optional[str] = None) -> int:
    net = (network or SOLANA_NETWORK or "devnet").lower()
    if net in ("mainnet-beta", "mainnet"):
        return SOLANA_MAINNET_CHAIN_ID
    return SOLANA_DEVNET_CHAIN_ID


def describe_solana_runtime() -> dict:
    network = SOLANA_NETWORK
    status = "devnet-mvp" if network in ("devnet", "") else "scaffold"
    return {
        "runtime": "solana-v1",
        "profileId": "solana-v1",
        "verifyArtifactId": "groth16-bn254-solana-altbn128-v1",
        "programId": SIPHON_PROGRAM_ID,
        "rpc": SOLANA_RPC_URL,
        "network": network,
        "chainId": solana_chain_id_for_network(),
        "status": status,
        "notes": (
            "Devnet MVP: SPL Deposit into siphon-vault-onchain PDAs; spend uses "
            "scaffold-verify (not mainnet-safe). Full Groth16/alt_bn128 is MAINNET-GATE."
            if status == "devnet-mvp"
            else (
                "Spend path: commit pending public inputs PDA, then spend with 256-byte "
                "Groth16 proof. Pairing via alt_bn128 once VK accounts are deployed."
            )
        ),
    }


def _hex_bytes(value: str, length: int, field: str) -> bytes:
    raw = value[2:] if value.startswith("0x") else value
    if len(raw) % 2:
        raw = "0" + raw
    try:
        out = bytes.fromhex(raw)
    except ValueError as exc:
        raise ValueError(f"{field} must be hex") from exc
    if len(out) > length:
        raise ValueError(f"{field} exceeds {length} bytes")
    return out.rjust(length, b"\0")


def _instruction_payload(tag: int, *parts: bytes) -> bytes:
    """Deterministic scaffold wire format until the program publishes its Anchor IDL."""
    return bytes([tag]) + b"".join(parts)


def _account_meta(pubkey: str, *, signer: bool = False, writable: bool = False, role: str) -> dict:
    return {"pubkey": pubkey, "isSigner": signer, "isWritable": writable, "role": role}


def build_commit_public_inputs_ix(
    *,
    payer: str,
    vault_pda: str,
    pending_inputs_pda: str,
    binder_hex: str,
    public_inputs_hex: list[str],
) -> dict:
    """Build Tx1's instruction description.

    Account order: payer (signer/writable), vault PDA (readonly), pending-inputs
    PDA (writable), system program (readonly). The pending PDA is one-shot and
    binder-scoped. Data is tag || binder[32] || 25 field limbs[32].
    """
    if len(public_inputs_hex) != 25:
        raise ValueError("solana-v1 requires exactly 25 public input limbs")
    data = _instruction_payload(
        2,
        _hex_bytes(binder_hex, 32, "binder"),
        *[_hex_bytes(v, 32, f"public input {i}") for i, v in enumerate(public_inputs_hex)],
    )
    return {
        "programId": SIPHON_PROGRAM_ID,
        "name": "commit_public_inputs",
        "accountMetas": [
            _account_meta(payer, signer=True, writable=True, role="relayer payer"),
            _account_meta(vault_pda, role="vault state PDA"),
            _account_meta(pending_inputs_pda, writable=True, role="pending public-inputs PDA"),
            _account_meta("11111111111111111111111111111111", role="system program"),
        ],
        "dataHex": data.hex(),
    }


def build_spend_ix(
    *,
    payer: str,
    vault_pda: str,
    pending_inputs_pda: str,
    compliance_pda: str,
    nullifier_store_pda: str,
    asset_vault: str,
    vk_account: str,
    proof_hex: str,
    raw_payee: str,
) -> dict:
    """Build Tx2's instruction description.

    Account order: payer, vault, pending inputs, compliance roots, nullifier
    store, asset vault, action VK, payee. Action-specific Jupiter/token accounts
    follow as remaining accounts when the deployed IDL requires them.
    """
    proof = _hex_bytes(proof_hex, 256, "proof")
    payee = raw_payee
    data = _instruction_payload(4, proof, bytes(32), bytes(32 * 8))
    return {
        "programId": SIPHON_PROGRAM_ID,
        "name": "spend",
        "accountMetas": [
            _account_meta(payer, signer=True, writable=True, role="relayer payer"),
            _account_meta(vault_pda, writable=True, role="vault state PDA"),
            _account_meta(pending_inputs_pda, writable=True, role="pending public-inputs PDA"),
            _account_meta(compliance_pda, role="compliance roots PDA"),
            _account_meta(nullifier_store_pda, writable=True, role="nullifier store PDA"),
            _account_meta(asset_vault, writable=True, role="SPL asset vault"),
            _account_meta(vk_account, role="action verification-key account"),
            _account_meta(payee, writable=True, role="raw payee"),
        ],
        "dataHex": data.hex(),
    }


def _configured_accounts() -> dict[str, str]:
    vault = os.getenv("SIPHON_SOLANA_VAULT_PDA", "").strip()
    compliance = os.getenv("SIPHON_SOLANA_COMPLIANCE_PDA", "").strip()
    if not vault or not compliance:
        try:
            from solders.pubkey import Pubkey

            program = Pubkey.from_string(SIPHON_PROGRAM_ID)
            if not vault:
                vault_pk, _ = Pubkey.find_program_address([b"siphon-vault-v1"], program)
                vault = str(vault_pk)
            if not compliance:
                comp_pk, _ = Pubkey.find_program_address([b"siphon-compliance-v1"], program)
                compliance = str(comp_pk)
        except Exception:
            vault = vault or SIPHON_PROGRAM_ID
            compliance = compliance or SIPHON_PROGRAM_ID
    return {
        "vault": vault,
        "pending": os.getenv("SIPHON_SOLANA_PENDING_INPUTS_PDA", SIPHON_PROGRAM_ID),
        "compliance": compliance,
        "nullifiers": os.getenv("SIPHON_SOLANA_NULLIFIER_STORE_PDA", SIPHON_PROGRAM_ID),
        "assetVault": os.getenv("SIPHON_SOLANA_ASSET_VAULT", SIPHON_PROGRAM_ID),
        "vk": os.getenv("SIPHON_SOLANA_VK_ACCOUNT", SIPHON_PROGRAM_ID),
    }


def confirm_solana_deposit(signature: str) -> dict[str, Any]:
    """Thin Devnet deposit confirm — RPC getTransaction presence check (hackathon)."""
    sig = (signature or "").strip()
    if not sig:
        raise ValueError("signature is required")
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [sig, {"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}],
    }
    req = urllib.request.Request(
        SOLANA_RPC_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        reply = json.load(response)
    if reply.get("error"):
        return {
            "ok": False,
            "pending": True,
            "runtime": "solana-v1",
            "status": "rpc_error",
            "programId": SIPHON_PROGRAM_ID,
            "signature": sig,
            "message": str(reply["error"]),
        }
    value = (reply.get("result") or None)
    if not value:
        return {
            "ok": False,
            "pending": True,
            "runtime": "solana-v1",
            "status": "not_found",
            "programId": SIPHON_PROGRAM_ID,
            "signature": sig,
            "message": "Transaction not found yet — retry shortly.",
        }
    meta = value.get("meta") or {}
    err = meta.get("err")
    ok = err is None
    return {
        "ok": ok,
        "pending": not ok,
        "runtime": "solana-v1",
        "status": "confirmed" if ok else "failed",
        "programId": SIPHON_PROGRAM_ID,
        "signature": sig,
        "slot": value.get("slot"),
        "message": "Deposit transaction confirmed on Solana." if ok else f"Transaction failed: {err}",
        "accounts": _configured_accounts(),
    }


def execute_solana_spend(
    *,
    public_inputs_hex: list[str],
    proof_hex: str,
    raw_payee: str,
) -> dict:
    """Build both spend transactions and submit only with a configured relayer.

    A missing signing key returns deterministic, inspectable pending messages.
    Having a key never produces a structural-accept success: either solders signs
    and the RPC accepts real transactions, or the result remains pending.
    """
    if not public_inputs_hex or len(public_inputs_hex) != 25:
        raise ValueError("solana-v1 requires exactly 25 public input limbs")
    if not proof_hex:
        raise ValueError("missing Groth16 proof")
    keypair_raw = (os.getenv("SOLANA_RELAYER_KEYPAIR") or "").strip()
    payer = os.getenv("SOLANA_RELAYER_PUBKEY", "RELAYER_PUBKEY_REQUIRED")
    binder = hashlib.sha256(
        ("|".join(public_inputs_hex) + "|" + raw_payee).encode("utf-8")
    ).hexdigest()
    accounts = _configured_accounts()
    commit_ix = build_commit_public_inputs_ix(
        payer=payer,
        vault_pda=accounts["vault"],
        pending_inputs_pda=accounts["pending"],
        binder_hex=binder,
        public_inputs_hex=public_inputs_hex,
    )
    spend_ix = build_spend_ix(
        payer=payer,
        vault_pda=accounts["vault"],
        pending_inputs_pda=accounts["pending"],
        compliance_pda=accounts["compliance"],
        nullifier_store_pda=accounts["nullifiers"],
        asset_vault=accounts["assetVault"],
        vk_account=accounts["vk"],
        proof_hex=proof_hex,
        raw_payee=raw_payee,
    )
    built = {
        "commitPublicInputsIx": commit_ix,
        "spendIx": spend_ix,
        # Deterministic unsigned message placeholders. Replace with canonical
        # solders Message bytes once the deployed program publishes its IDL.
        "commitMessageHex": json.dumps(commit_ix, sort_keys=True, separators=(",", ":")).encode().hex(),
        "spendMessageHex": json.dumps(spend_ix, sort_keys=True, separators=(",", ":")).encode().hex(),
    }
    if not keypair_raw:
        return {
            "ok": False,
            "pending": True,
            "runtime": "solana-v1",
            "message": "Built Solana spend messages; SOLANA_RELAYER_KEYPAIR is not configured.",
            "programId": SIPHON_PROGRAM_ID,
            **built,
        }

    try:
        from solders.hash import Hash
        from solders.instruction import AccountMeta, Instruction
        from solders.keypair import Keypair
        from solders.pubkey import Pubkey
        from solders.transaction import Transaction

        if keypair_raw.startswith("["):
            keypair = Keypair.from_bytes(bytes(json.loads(keypair_raw)))
        else:
            try:
                keypair = Keypair.from_base58_string(keypair_raw)
            except ValueError:
                keypair = Keypair.from_bytes(base64.b64decode(keypair_raw, validate=True))
        payer = str(keypair.pubkey())

        def solders_ix(desc: dict) -> Instruction:
            metas = [
                AccountMeta(Pubkey.from_string(m["pubkey"]), m["isSigner"], m["isWritable"])
                for m in desc["accountMetas"]
            ]
            return Instruction(Pubkey.from_string(desc["programId"]), bytes.fromhex(desc["dataHex"]), metas)

        rpc_req = urllib.request.Request(
            SOLANA_RPC_URL,
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getLatestBlockhash"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(rpc_req, timeout=15) as response:
            blockhash = json.load(response)["result"]["value"]["blockhash"]

        signatures = []
        for desc in (commit_ix, spend_ix):
            desc["accountMetas"][0]["pubkey"] = payer
            tx = Transaction.new_signed_with_payer(
                [solders_ix(desc)], keypair.pubkey(), [keypair], Hash.from_string(blockhash)
            )
            encoded = base64.b64encode(bytes(tx)).decode()
            send_req = urllib.request.Request(
                SOLANA_RPC_URL,
                data=json.dumps({
                    "jsonrpc": "2.0", "id": 1, "method": "sendTransaction",
                    "params": [encoded, {"encoding": "base64", "preflightCommitment": "confirmed"}],
                }).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(send_req, timeout=30) as response:
                reply = json.load(response)
            if reply.get("error"):
                raise RuntimeError(f"Solana RPC rejected transaction: {reply['error']}")
            signatures.append(reply["result"])
        return {
            "ok": True,
            "pending": False,
            "runtime": "solana-v1",
            "status": "submitted",
            "txSignatures": signatures,
            "tx_hash": signatures[-1],
            "programId": SIPHON_PROGRAM_ID,
            **built,
        }
    except Exception as exc:
        logger.exception("Solana spend signing/submission failed")
        return {
            "ok": False,
            "pending": True,
            "runtime": "solana-v1",
            "message": f"Solana spend built but not submitted: {exc}",
            "programId": SIPHON_PROGRAM_ID,
            **built,
        }


def execute_solana_spend_stub(
    *,
    public_inputs_hex: list[str],
    proof_hex: str,
    raw_payee: str,
) -> dict:
    """Compatibility wrapper for older executor call sites."""
    return execute_solana_spend(
        public_inputs_hex=public_inputs_hex,
        proof_hex=proof_hex,
        raw_payee=raw_payee,
    )

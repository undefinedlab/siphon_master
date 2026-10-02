"""Import-only shims over the trade-executor — REUSE, never reimplement (locked decision D1).

The gateway's pythonpath includes ../trade-executor, so the executor's already-hardened, already-
tested helpers are imported directly. Reimplementing auth or sanctions here is the one thing that
reintroduces bugs, so this module deliberately contains no logic of its own beyond `recover_wallet`,
which wraps eth_account exactly as the executor's wallet_auth does (EIP-191 personal_sign recovery).
"""
import base64

import base58
from eth_account import Account
from eth_account.messages import encode_defunct

# Sanctions + recipient validation — re-exported straight from the executor (fail-CLOSED handling on
# the write path is applied at the gateway service layer, not here).
from address_validator import check_sanctions, validate_recipient  # noqa: F401 (re-export)

# Session-key delegation — re-exported from the executor rather than reimplemented (D1). The
# delegation message is byte-compared during verification, so two independent copies of the builder
# would silently reject every session the moment one drifted. One definition, two consumers.
from session_key import (  # noqa: F401 (re-export)
    SESSION_HEADER,
    delegated_signer_authorizes,
    verify_delegation,
)


def recover_wallet(message: str, signature: str) -> str | None:
    """Recover the lowercased signer address from an EIP-191 personal_sign signature, or None.

    Mirrors the executor's wallet_auth recovery exactly (encode_defunct(text=...) +
    Account.recover_message) so a signature that authenticates to the executor authenticates here.
    """
    try:
        return Account.recover_message(encode_defunct(text=message), signature=signature).lower()
    except Exception:
        return None


def is_solana_address(address: str) -> bool:
    """A base58 ed25519 public key (Phantom / Solana CLI). Never true for a 0x address: '0' is not
    in the base58 alphabet."""
    try:
        return 32 <= len(address) <= 44 and len(base58.b58decode(address)) == 32
    except Exception:
        return False


def solana_signature_valid(message: str, signature: str, wallet: str) -> bool:
    """Ed25519 over the UTF-8 message, signature base64 — what Phantom `signMessage` and
    `nacl.sign.detached` produce. The base58 wallet is used verbatim: case is part of the key."""
    try:
        from solders.pubkey import Pubkey
        from solders.signature import Signature

        return Signature.from_bytes(base64.b64decode(signature, validate=True)).verify(
            Pubkey.from_string(wallet), message.encode("utf-8")
        )
    except Exception:
        return False

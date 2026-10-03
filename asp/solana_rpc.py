"""Minimal Solana JSON-RPC + siphon-vault-zk event decoding for the ASP.

Event layouts mirror `siphon-contracts-v2/solana/programs/siphon-vault-zk/src/lib.rs`
(Anchor `emit!` → "Program data: base64(disc8 || borsh)"). Field limbs are 32-byte
little-endian; they are returned here as decimal field strings, the same form the app
sends to /screen as `commitment`.
"""
from __future__ import annotations

import base64
import hashlib
import os
import time
from dataclasses import dataclass
from typing import Any

import requests

from core.poseidon import SNARK_SCALAR_FIELD

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _BASE58_ALPHABET[r] + out
    pad = len(raw) - len(raw.lstrip(b"\x00"))
    return "1" * pad + out


def le_to_field(raw: bytes) -> int:
    return int.from_bytes(raw, "little") % SNARK_SCALAR_FIELD


def field_to_le32(value: int) -> bytes:
    return int(value % SNARK_SCALAR_FIELD).to_bytes(32, "little")


def _disc(kind: str, name: str) -> bytes:
    return hashlib.sha256(f"{kind}:{name}".encode()).digest()[:8]


DEPOSIT_EVENT_DISC = _disc("event", "DepositEvent")
LEAF_INSERTED_DISC = _disc("event", "LeafInserted")
ROOTS_PUBLISHED_DISC = _disc("event", "RootsPublished")
PUBLISH_ROOTS_IX_DISC = _disc("global", "publish_roots")


@dataclass(frozen=True)
class LeafEvent:
    """One state-tree insert: a deposit (with depositor/nonce) or a spend-side change note."""

    kind: str  # "deposit" | "change"
    leaf_index: int
    commitment: str  # decimal field element
    signature: str
    slot: int
    depositor: str | None = None
    mint: str | None = None
    deposit_nonce: int | None = None


def decode_leaf_events(log_messages: list[str], *, signature: str, slot: int) -> list[LeafEvent]:
    out: list[LeafEvent] = []
    for line in log_messages or []:
        if not line.startswith("Program data: "):
            continue
        try:
            raw = base64.b64decode(line[len("Program data: "):])
        except Exception:
            continue
        head, body = raw[:8], raw[8:]
        if head == DEPOSIT_EVENT_DISC and len(body) >= 32 + 32 + 32 + 8 + 8:
            out.append(
                LeafEvent(
                    kind="deposit",
                    depositor=b58encode(body[0:32]),
                    mint=b58encode(body[32:64]),
                    commitment=str(le_to_field(body[64:96])),
                    leaf_index=int.from_bytes(body[96:104], "little"),
                    deposit_nonce=int.from_bytes(body[104:112], "little"),
                    signature=signature,
                    slot=slot,
                )
            )
        elif head == LEAF_INSERTED_DISC and len(body) >= 32 + 8:
            out.append(
                LeafEvent(
                    kind="change",
                    commitment=str(le_to_field(body[0:32])),
                    leaf_index=int.from_bytes(body[32:40], "little"),
                    signature=signature,
                    slot=slot,
                )
            )
    return out


class SolanaRpc:
    """Thin JSON-RPC client with 429 backoff (public devnet RPC rate-limits hard)."""

    def __init__(self, url: str | None = None, *, timeout: float = 30.0) -> None:
        self.url = (url or os.getenv("SOLANA_RPC_URL", "")).strip()
        if not self.url:
            raise RuntimeError("SOLANA_RPC_URL required")
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, params: list[Any] | None = None) -> Any:
        delay = 0.5
        for attempt in range(8):
            self._id += 1
            resp = requests.post(
                self.url,
                json={"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or []},
                timeout=self.timeout,
            )
            if resp.status_code == 429 and attempt < 7:
                time.sleep(delay)
                delay = min(delay * 2, 16)
                continue
            resp.raise_for_status()
            body = resp.json()
            if "error" in body:
                err = body["error"]
                if isinstance(err, dict) and err.get("code") == 429 and attempt < 7:
                    time.sleep(delay)
                    delay = min(delay * 2, 16)
                    continue
                raise RuntimeError(f"{method}: {err}")
            return body.get("result")
        raise RuntimeError(f"{method}: rate limited")

    def signatures_for_address(
        self, address: str, *, before: str | None = None, until: str | None = None, limit: int = 1000
    ) -> list[dict]:
        opts: dict[str, Any] = {"limit": limit, "commitment": "confirmed"}
        if before:
            opts["before"] = before
        if until:
            opts["until"] = until
        return self.call("getSignaturesForAddress", [address, opts]) or []

    def transaction(self, signature: str) -> dict | None:
        return self.call(
            "getTransaction",
            [signature, {"commitment": "confirmed", "maxSupportedTransactionVersion": 0, "encoding": "json"}],
        )

    def account_data(self, address: str) -> bytes | None:
        res = self.call("getAccountInfo", [address, {"encoding": "base64", "commitment": "confirmed"}])
        value = (res or {}).get("value")
        if not value:
            return None
        return base64.b64decode(value["data"][0])

    def program_accounts(self, program_id: str, *, data_size: int | None = None) -> list[dict]:
        """`getProgramAccounts` — used to list LeafIndexAccount PDAs without walking vault history."""
        opts: dict[str, Any] = {"encoding": "base64", "commitment": "confirmed"}
        if data_size is not None:
            opts["filters"] = [{"dataSize": data_size}]
        return self.call("getProgramAccounts", [program_id, opts]) or []

    def latest_blockhash(self) -> str:
        return self.call("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]

    def send_raw(self, tx_bytes: bytes) -> str:
        return self.call(
            "sendTransaction",
            [base64.b64encode(tx_bytes).decode(), {"encoding": "base64", "preflightCommitment": "confirmed"}],
        )

    def confirm(self, signature: str, *, timeout_sec: float = 60.0) -> dict:
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            st = self.call("getSignatureStatuses", [[signature], {"searchTransactionHistory": True}])
            status = ((st or {}).get("value") or [None])[0]
            if status and status.get("confirmationStatus") in ("confirmed", "finalized"):
                if status.get("err"):
                    raise RuntimeError(f"tx {signature} failed: {status['err']}")
                return status
            time.sleep(1.5)
        raise TimeoutError(f"tx {signature} not confirmed in {timeout_sec}s")

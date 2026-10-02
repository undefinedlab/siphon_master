"""Devnet FHE+pool E2E: deposit notes → createStrategy (900002) → executeStrategy → siphon-pool-v1.

Arms both LIMIT_SELL (USDC→WSOL) and LIMIT_BUY (WSOL→USDC). Settle uses the upgraded
bidirectional strategy_swap; FHE bounds are stored (engine optional for this fire path).

Usage (from trade-executor, executor on :5020):
  python e2e_devnet_fhe_pool.py
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("SOLANA_RPC_URL", "https://api.devnet.solana.com")
os.environ.setdefault(
    "SIPHON_PROGRAM_ID", "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj"
)
os.environ.setdefault(
    "SOLANA_USDC_MINT", "DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie"
)

EXECUTOR = os.getenv("TRADE_EXECUTOR_URL", "http://127.0.0.1:5020").rstrip("/")
RPC = os.environ["SOLANA_RPC_URL"].rstrip("/")
PROGRAM = os.environ["SIPHON_PROGRAM_ID"]
USDC = os.environ["SOLANA_USDC_MINT"]
WSOL = "So11111111111111111111111111111111111111112"
TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ASSOC = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
COMMIT_DOMAIN = b"siphon-solana-devnet-deposit-v1"


def _rpc(method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        reply = json.load(resp)
    if reply.get("error"):
        raise RuntimeError(f"{method}: {reply['error']}")
    return reply["result"]


def _http(method: str, path: str, payload: dict | None = None, headers: dict | None = None):
    data = None if payload is None else json.dumps(payload).encode()
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(f"{EXECUTOR}{path}", data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": body}


def _disc(name: str) -> bytes:
    return hashlib.sha256(f"global:{name}".encode()).digest()[:8]


def _load_kp():
    from solders.keypair import Keypair

    raw = Path.home() / ".config" / "solana" / "id.json"
    return Keypair.from_bytes(bytes(json.loads(raw.read_text(encoding="utf-8"))))


def _pdas():
    from solders.pubkey import Pubkey

    program = Pubkey.from_string(PROGRAM)
    vault, _ = Pubkey.find_program_address([b"siphon-vault-v1"], program)
    pool, _ = Pubkey.find_program_address([b"siphon-pool-v1"], program)
    return vault, pool


def _ata(owner, mint):
    from solders.pubkey import Pubkey
    from solders.token.associated import get_associated_token_address

    return get_associated_token_address(Pubkey.from_string(str(owner)), Pubkey.from_string(str(mint)))


def _send_ixs(kp, ixs):
    from solders.hash import Hash
    from solders.transaction import Transaction

    bh = _rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]
    tx = Transaction.new_signed_with_payer(ixs, kp.pubkey(), [kp], Hash.from_string(bh))
    enc = base64.b64encode(bytes(tx)).decode()
    return _rpc("sendTransaction", [enc, {"encoding": "base64", "preflightCommitment": "confirmed"}])


def _ensure_ata(kp, owner, mint):
    from solders.instruction import AccountMeta, Instruction
    from solders.pubkey import Pubkey
    from solders.system_program import ID as SYSTEM_PROGRAM_ID

    ata = _ata(owner, mint)
    info = _rpc("getAccountInfo", [str(ata), {"encoding": "base64"}])
    if info and info.get("value"):
        return ata
    ix = Instruction(
        Pubkey.from_string(ASSOC),
        bytes([1]),
        [
            AccountMeta(kp.pubkey(), True, True),
            AccountMeta(ata, False, True),
            AccountMeta(Pubkey.from_string(str(owner)), False, False),
            AccountMeta(Pubkey.from_string(str(mint)), False, False),
            AccountMeta(SYSTEM_PROGRAM_ID, False, False),
            AccountMeta(Pubkey.from_string(TOKEN), False, False),
        ],
    )
    sig = _send_ixs(kp, [ix])
    print("create ATA", mint, sig)
    return ata


def _wrap_sol(kp, lamports: int):
    from solders.instruction import AccountMeta, Instruction
    from solders.pubkey import Pubkey
    from solders.system_program import transfer, TransferParams

    ata = _ensure_ata(kp, kp.pubkey(), WSOL)
    sync = Instruction(
        Pubkey.from_string(TOKEN),
        bytes([17]),  # SyncNative
        [AccountMeta(ata, False, True)],
    )
    ixs = [
        transfer(TransferParams(from_pubkey=kp.pubkey(), to_pubkey=ata, lamports=lamports)),
        sync,
    ]
    sig = _send_ixs(kp, ixs)
    print("wrap", lamports, sig)
    return ata


def _deposit(kp, mint: str, amount: int):
    from solders.instruction import AccountMeta, Instruction
    from solders.pubkey import Pubkey
    from solders.system_program import ID as SYSTEM_PROGRAM_ID

    vault, _ = _pdas()
    user_ata = _ensure_ata(kp, kp.pubkey(), mint)
    vault_ata = _ensure_ata(kp, vault, mint)
    user_salt = os.urandom(32)
    if all(b == 0 for b in user_salt):
        user_salt = b"\x01" + user_salt[1:]
    pre = os.urandom(32)
    amount_le = struct.pack("<Q", amount)
    commitment = hashlib.sha256(
        COMMIT_DOMAIN + amount_le + bytes(Pubkey.from_string(mint)) + user_salt + pre
    ).digest()
    note, _ = Pubkey.find_program_address([b"siphon-note-v1", commitment], Pubkey.from_string(PROGRAM))
    data = _disc("deposit") + amount_le + user_salt + pre
    ix = Instruction(
        Pubkey.from_string(PROGRAM),
        data,
        [
            AccountMeta(kp.pubkey(), True, True),
            AccountMeta(vault, False, True),
            AccountMeta(Pubkey.from_string(mint), False, False),
            AccountMeta(user_ata, False, True),
            AccountMeta(vault_ata, False, True),
            AccountMeta(note, False, True),
            AccountMeta(Pubkey.from_string(TOKEN), False, False),
            AccountMeta(Pubkey.from_string(ASSOC), False, False),
            AccountMeta(SYSTEM_PROGRAM_ID, False, False),
        ],
    )
    sig = _send_ixs(kp, [ix])
    print("deposit", mint[:8], amount, "note", str(note), sig)
    return str(note)


def _arm_and_fire(user: str, note: str, side: str, amount: float, asset_in: str, asset_out: str):
    headers = {"X-Solana-Address": user}
    # Stub server key so createStrategy accepts the Solana user (Devnet open arm).
    st, body = _http(
        "POST",
        "/uploadServerKey",
        {"user_id": user, "server_key": "00" * 32, "canary": "00"},
        headers,
    )
    if st >= 400 and "already" not in str(body).lower():
        print("uploadServerKey", st, body)

    sell_usdc = side == "sell_usdc"
    payload = {
        "user_id": user,
        "strategy_type": "LIMIT_SELL" if sell_usdc else "LIMIT_BUY",
        "asset_in": asset_in,
        "asset_out": asset_out,
        "amount": amount,
        "recipient_address": user,
        "from_chain": "900002",
        "to_chain": "900002",
        "encrypted_upper_bound": "00",
        "encrypted_lower_bound": "00",
        "solana_note_pda": note,
        "solana_side": side,
        "solana_mint": USDC if sell_usdc else WSOL,
        "solana_usdc_mint": USDC,
        "zkp_data": {
            "venue": "siphon-pool-v1",
            "solana_note_pda": note,
            "solana_side": side,
            "solana_mint": USDC if sell_usdc else WSOL,
            "solana_usdc_mint": USDC,
        },
    }
    st, body = _http("POST", "/createStrategy", payload, headers)
    print("createStrategy", side, st, body)
    if st >= 400:
        raise SystemExit(f"createStrategy failed: {body}")
    sid = body.get("strategy_id") or body.get("id")
    if not sid:
        raise SystemExit(f"no strategy_id: {body}")

    st, body = _http(
        "POST",
        "/executeStrategy",
        {"strategy_id": sid, "user_id": user},
        headers,
    )
    print("executeStrategy", side, st, body)
    if st >= 400 or body.get("status") in ("FAILED", "failed"):
        raise SystemExit(f"execute failed: {body}")
    return sid, body


def main() -> None:
    import urllib.error  # noqa: F401 — used in _http

    # health
    st, health = _http("GET", "/health")
    print("executor", st, health)
    if st != 200:
        raise SystemExit("executor not healthy on :5020 — start run_devnet_executor.py")

    kp = _load_kp()
    user = str(kp.pubkey())
    print("user", user)

    _ensure_ata(kp, user, USDC)
    _wrap_sol(kp, 20_000_000)  # 0.02 SOL spare for WSOL note

    note_usdc = _deposit(kp, USDC, 1_000_000)  # 1 USDC
    note_wsol = _deposit(kp, WSOL, 10_000_000)  # 0.01 SOL

    sid_a, res_a = _arm_and_fire(user, note_usdc, "sell_usdc", 1.0, "USDC", "SOL")
    sid_b, res_b = _arm_and_fire(user, note_wsol, "sell_wsol", 0.01, "SOL", "USDC")

    out = {
        "user": user,
        "limit_sell": {"strategy_id": sid_a, "result": res_a, "note": note_usdc},
        "limit_buy": {"strategy_id": sid_b, "result": res_b, "note": note_wsol},
        "venue": "siphon-pool-v1",
    }
    out_path = ROOT / "instance" / "devnet-fhe-pool-e2e.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("PASS FHE+pool bidi —", out_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("FAIL", e, file=sys.stderr)
        raise

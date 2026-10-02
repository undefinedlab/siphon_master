"""Minimal local server for Solana→EVM fund / Devnet bridge smoke tests."""
from __future__ import annotations

import os
from pathlib import Path

# Load local Devnet env before importing bridge helpers that read os.environ.
_env_file = Path(__file__).resolve().parent / ".env.anvil"
if _env_file.is_file():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        _k, _v = _k.strip(), _v.strip().strip('"').strip("'")
        if _k and _k not in os.environ:
            os.environ[_k] = _v

# Mint key lives in the contracts deployer .env (gitignored) — do not duplicate.
_contracts_env = (
    Path(__file__).resolve().parents[2] / "siphon-contracts-v2" / "evm" / ".env"
)
if _contracts_env.is_file() and not os.environ.get("DEVNET_BRIDGE_KEY"):
    for _line in _contracts_env.read_text(encoding="utf-8").splitlines():
        if _line.startswith("PRIVATE_KEY="):
            _pk = _line.split("=", 1)[1].strip().strip('"').strip("'")
            if _pk:
                os.environ["DEVNET_BRIDGE_KEY"] = _pk
            break

from flask import Flask, jsonify, request
from flask_cors import CORS

from intent_bridge import execute_wallet_fund_hop
from solana_runtime import SOLANA_CHAIN_IDS

app = Flask(__name__)
CORS(
    app,
    resources={
        r"/*": {
            "origins": [
                "http://localhost:3000",
                "http://127.0.0.1:3000",
                "http://localhost:3002",
                "http://127.0.0.1:3002",
                "http://localhost:3003",
                "http://127.0.0.1:3003",
                "http://localhost:3006",
                "http://127.0.0.1:3006",
            ],
            "allow_headers": ["Content-Type"],
            "methods": ["GET", "POST", "OPTIONS"],
        }
    },
)


@app.get("/health")
def health():
    return jsonify({"status": "healthy", "service": "trade-executor-fundbase-smoke"}), 200


@app.post("/solana/fundBase/plan")
def solana_fund_base_plan():
    data = request.get_json(silent=True) or {}
    required = ("from_chain_id", "amount", "asset", "recipient", "solana_owner")
    missing = [field for field in required if data.get(field) in (None, "")]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400
    try:
        from_cid = int(data["from_chain_id"])
        to_cid = int(data.get("to_chain_id") or 8453)
        if from_cid not in SOLANA_CHAIN_IDS:
            return jsonify({"error": f"from_chain_id must be Solana; got {from_cid}"}), 400
        recipient = str(data["recipient"])
        if not recipient.startswith("0x") or len(recipient) != 42:
            return jsonify({"error": "recipient must be a Base EVM address"}), 400
        result = execute_wallet_fund_hop(
            from_chain_id=from_cid,
            to_chain_id=to_cid,
            amount=data["amount"],
            asset=data["asset"],
            recipient=recipient,
            solana_owner=data["solana_owner"],
            mint=data.get("mint"),
            bridge_adapter=data.get("bridge_adapter", "lifi"),
        )
        return jsonify(result), 202 if result.get("pending") else 200
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.post("/solana/devnetBridge/plan")
def solana_devnet_bridge_plan():
    data = request.get_json(silent=True) or {}
    try:
        from solana_devnet_bridge import describe_devnet_bridge_plan

        amount = int(data.get("amount") or data.get("usdc_amount") or data.get("lamports") or 0)
        return jsonify(
            describe_devnet_bridge_plan(
                amount=amount,
                solana_owner=str(data.get("solana_owner") or ""),
                recipient=str(data.get("recipient") or ""),
            )
        ), 202
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/solana/devnetBridge/execute")
def solana_devnet_bridge_execute():
    data = request.get_json(silent=True) or {}
    try:
        from solana_devnet_bridge import execute_devnet_bridge_mint

        recipient = str(data.get("recipient") or "")
        if not recipient.startswith("0x") or len(recipient) != 42:
            return jsonify({"error": "recipient must be a Sepolia EVM address"}), 400
        amount = int(data.get("amount") or data.get("usdc_amount") or data.get("lamports") or 0)
        result = execute_devnet_bridge_mint(
            amount=amount,
            solana_owner=str(data.get("solana_owner") or ""),
            recipient=recipient,
        )
        return jsonify(result), 200 if result.get("ok") else 202
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5005"))
    print(f"fundBase smoke server on http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)

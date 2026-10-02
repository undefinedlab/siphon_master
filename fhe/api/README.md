# Siphon Public API

Stable HTTP contract for Siphon Protocol — the surface the TypeScript SDK and MCP server will wrap.

**Served by:** `siphon-fhe/trade-executor` (default port `5005`)  
**Spec:** [`openapi.yaml`](./openapi.yaml) (OpenAPI 3.1)

## Scope

| In (public / client) | Out (internal) |
|----------------------|----------------|
| Health | FHE engine (`:5001`) |
| Vault index reads | Decryptor TEE |
| Strategies (create / list / abort / result) | Order signer TEE |
| Notes + commitments + precommitments | Nullifier registry (executor token) |
| Receipts (mint / list / verify) | Admin allow-list & fee sweep |
| FHE server-key upload / status | Raw indexer GraphQL |

Internal executor-only routes (e.g. `/nullifier-registry/*`, `/admin/*`) exist on the same host but are **not** part of this contract.

## Auth models

1. **Wallet signature** — `X-Wallet-Address`, `X-Signature`, `X-Timestamp`  
   Message: `Siphon auth v1:<timestamp>`
2. **Tag HMAC** — `X-Tag`, `X-Auth-Token`  
   Token: `HMAC-SHA256(tag, "siphon-auth-v1")`
3. **API token** — `X-API-TOKEN` (or `Authorization: Bearer …`)  
   Shared secret for executor/service callers on dual-auth routes

See the [Siphon docs API section](https://github.com/SiphonMoney/docs) for human-readable reference.

## Versioning

Paths are unversioned today (`/health`, `/createStrategy`, …). This package is **API v1**. Breaking changes bump the package major version and will introduce `/v1/...` aliases before old paths are removed.

## Testing

```bash
cd siphon-api
pip install -r requirements-dev.txt
pytest
```

Trade-executor auth unit tests:

```bash
cd siphon-fhe/trade-executor
pytest tests/test_auth_hardening.py
```

Optional live checks (trade-executor running):

```bash
SIPHON_API_BASE=http://127.0.0.1:5005 pytest
```

## Auth (v1.1)

- Reads: long-lived `Siphon auth v1:<ts>`
- Writes: `POST /auth/challenge` then `Siphon auth v1:write:<nonce>`
- Never send `API_TOKEN` from the browser

## Next steps

1. Generate SDK clients from `openapi.yaml`
2. Wrap read tools first as MCP
3. Optionally mount `/v1` aliases in trade-executor that mirror this spec

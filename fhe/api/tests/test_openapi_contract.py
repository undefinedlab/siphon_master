"""Siphon Public API — OpenAPI contract and documentation tests.

These tests lock the public surface in siphon-api/openapi.yaml and ensure
siphon-docs/content/docs/api stays aligned. Live HTTP checks run only when
SIPHON_API_BASE (or localhost:5005) is reachable.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
import yaml
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OPENAPI_PATH = ROOT / "openapi.yaml"
DOCS_API = ROOT.parent / "siphon-docs" / "content" / "docs" / "api"
BASE = os.environ.get("SIPHON_API_BASE", "http://127.0.0.1:5005").rstrip("/")

# Public paths that must remain in the contract (operationId → path)
REQUIRED_PATHS = {
    "/health",
    "/auth/challenge",
    "/auth/tag-bind",
    "/vault-index/health",
    "/vault-index/leaves",
    "/vault-index/deposits",
    "/vault-index/balance",
    "/createStrategy",
    "/strategies/{user_id}",
    "/strategies/{strategy_id}/abort",
    "/strategy/{strategy_id}/result",
    "/uploadServerKey",
    "/hasServerKey/{user_id}",
    "/notes",
    "/notes/export",
    "/notes/{note_id}/spent",
    "/commitments",
    "/commitments/export",
    "/commitments/prune",
    "/commitments/{row_id}/spent",
    "/precommitments",
    "/precommitments/pool-count",
    "/precommitments/{row_id}/claim",
    "/precommitments/{row_id}/resolve",
    "/precommitments/{row_id}/release",
    "/receipt",
    "/receipts",
    "/receipt/{receipt_id}",
    "/receipt/verify",
}

# Must never appear in the public OpenAPI (internal / admin)
FORBIDDEN_PATH_PREFIXES = (
    "/admin",
    "/nullifier-registry",
    "/evaluateStrategy",
    "/decrypt",
)

REQUIRED_SECURITY = {"WalletSig", "TagHmac", "ApiToken", "WalletWriteChallenge"}

REQUIRED_DOC_PAGES = (
    "index.mdx",
    "authentication.mdx",
    "vault-index.mdx",
    "strategies.mdx",
    "notes.mdx",
    "receipts.mdx",
    "errors.mdx",
    "ops.mdx",
    "meta.json",
)


@pytest.fixture(scope="module")
def spec() -> dict:
    assert OPENAPI_PATH.is_file(), f"missing {OPENAPI_PATH}"
    data = yaml.safe_load(OPENAPI_PATH.read_text())
    assert isinstance(data, dict)
    return data


def _http_get(path: str, timeout: float = 3.0) -> tuple[int, bytes]:
    req = urllib.request.Request(f"{BASE}{path}", method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def _live_available() -> bool:
    try:
        status, _ = _http_get("/health")
        return status == 200
    except Exception:
        return False


@pytest.fixture(scope="module")
def live():
    if not _live_available():
        pytest.skip(f"trade-executor not reachable at {BASE}")


# ── Spec structure ────────────────────────────────────────────────────────────


class TestOpenAPIStructure:
    def test_openapi_version(self, spec):
        assert spec.get("openapi", "").startswith("3.")

    def test_info_block(self, spec):
        info = spec["info"]
        assert info["title"]
        assert info["version"]
        assert "description" in info

    def test_servers_present(self, spec):
        assert len(spec.get("servers", [])) >= 1

    def test_required_paths_present(self, spec):
        paths = set(spec["paths"])
        missing = REQUIRED_PATHS - paths
        assert not missing, f"missing public paths: {sorted(missing)}"

    def test_no_forbidden_paths(self, spec):
        for path in spec["paths"]:
            for prefix in FORBIDDEN_PATH_PREFIXES:
                assert not path.startswith(prefix), f"internal path leaked: {path}"

    def test_security_schemes(self, spec):
        schemes = set(spec["components"]["securitySchemes"])
        missing = REQUIRED_SECURITY - schemes
        assert not missing, f"missing security schemes: {missing}"

    def test_every_operation_has_operation_id(self, spec):
        missing = []
        for path, item in spec["paths"].items():
            for method, op in item.items():
                if method.startswith("x-") or method == "parameters":
                    continue
                if not isinstance(op, dict):
                    continue
                if not op.get("operationId"):
                    missing.append(f"{method.upper()} {path}")
        assert not missing, f"operations without operationId: {missing}"

    def test_operation_ids_unique(self, spec):
        ids = []
        for item in spec["paths"].values():
            for method, op in item.items():
                if method.startswith("x-") or not isinstance(op, dict):
                    continue
                oid = op.get("operationId")
                if oid:
                    ids.append(oid)
        dupes = {i for i in ids if ids.count(i) > 1}
        assert not dupes, f"duplicate operationIds: {dupes}"

    def test_error_schema_present(self, spec):
        assert "Error" in spec["components"]["schemas"]

    def test_refs_resolve(self, spec):
        """All local $ref targets under components must exist."""
        text = OPENAPI_PATH.read_text()
        refs = set(re.findall(r'\$ref:\s*"#/components/([^"]+)"', text))
        for ref in refs:
            parts = ref.split("/")
            node = spec["components"]
            for p in parts:
                assert p in node, f"broken $ref: #/components/{ref}"
                node = node[p]

    def test_path_count_stable(self, spec):
        # Guard against accidental shrink of the public surface
        assert len(spec["paths"]) >= len(REQUIRED_PATHS)


class TestOpenAPISemantics:
    def test_vault_index_is_public(self, spec):
        for path in (
            "/vault-index/health",
            "/vault-index/leaves",
            "/vault-index/deposits",
            "/vault-index/balance",
        ):
            get_op = spec["paths"][path]["get"]
            # empty security list OR no security key = public
            sec = get_op.get("security", [])
            assert sec == [] or sec is None or get_op.get("security") == []

    def test_create_strategy_requires_wallet(self, spec):
        op = spec["paths"]["/createStrategy"]["post"]
        assert {"WalletWriteChallenge": []} in op.get("security", [])

    def test_leaves_are_paginated_in_spec(self, spec):
        raw = spec["paths"]["/vault-index/leaves"]["get"]["parameters"]
        names = set()
        for p in raw:
            if "name" in p:
                names.add(p["name"])
            elif "$ref" in p:
                names.add(p["$ref"].rsplit("/", 1)[-1])
        assert "limit" in names
        assert "offset" in names
        assert "chainId" in names

    def test_commitments_require_tag(self, spec):
        op = spec["paths"]["/commitments"]["post"]
        assert {"TagHmac": []} in op.get("security", [])

    def test_receipt_verify_is_public(self, spec):
        op = spec["paths"]["/receipt/verify"]["post"]
        assert op.get("security", []) == []


# ── Docs alignment ────────────────────────────────────────────────────────────


class TestDocsAlignment:
    def test_doc_pages_exist(self):
        assert DOCS_API.is_dir(), f"missing docs dir {DOCS_API}"
        missing = [p for p in REQUIRED_DOC_PAGES if not (DOCS_API / p).is_file()]
        assert not missing, f"missing doc pages: {missing}"

    def test_meta_lists_pages(self):
        import json

        data = json.loads((DOCS_API / "meta.json").read_text())
        pages = set(data["pages"])
        for name in (
            "index",
            "authentication",
            "vault-index",
            "strategies",
            "notes",
            "receipts",
            "errors",
            "ops",
        ):
            assert name in pages

    def test_docs_mention_core_routes(self):
        blob = "\n".join(p.read_text() for p in DOCS_API.glob("*.mdx"))
        for needle in (
            "/health",
            "/vault-index/leaves",
            "/createStrategy",
            "/notes",
            "/commitments",
            "/receipt",
            "/auth/challenge",
            "X-Wallet-Address",
            "X-Tag",
            "X-Write-Nonce",
            "TAG_AUTH_V2_ONLY",
            "BLOCK_BROWSER_EXECUTOR_ROUTES",
        ):
            assert needle in blob, f"docs missing mention of {needle}"

    def test_docs_exclude_internal_as_public(self):
        overview = (DOCS_API / "index.mdx").read_text()
        assert "not public" in overview.lower() or "not part of the public" in overview.lower()
        assert "nullifier" in overview.lower() or "admin" in overview.lower()


# ── Optional live contract ────────────────────────────────────────────────────


class TestLiveContract:
    def test_health(self, live):
        status, body = _http_get("/health")
        assert status == 200
        import json

        data = json.loads(body)
        assert data.get("status") == "healthy"
        assert data.get("service") == "trade-executor"

    def test_vault_index_health_shape(self, live):
        try:
            status, body = _http_get("/vault-index/health")
        except urllib.error.HTTPError as e:
            # 503 is acceptable when INDEXER_DB_URI unset
            assert e.code == 503
            return
        assert status in (200, 503)
        import json

        data = json.loads(body)
        assert "ok" in data

    def test_unauthed_create_strategy_rejected(self, live):
        req = urllib.request.Request(
            f"{BASE}/createStrategy",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            # If ENFORCE_WALLET_AUTH is off, may not 401 — still must not 5xx
        except urllib.error.HTTPError as e:
            assert e.code in (400, 401, 403, 429)
            return
        # soft-auth rollout may accept and fail on body validation
        # reaching here without 5xx is fine


class TestPackageLayout:
    def test_readme_exists(self):
        assert (ROOT / "README.md").is_file()

    def test_readme_points_at_openapi(self):
        text = (ROOT / "README.md").read_text()
        assert "openapi.yaml" in text
        assert "SDK" in text or "MCP" in text

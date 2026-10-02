"""The published gateway contract must not drift from the code that serves it.

Without this, `siphon-api/gateway-openapi.yaml` silently rots the first time someone adds a route,
and an integrator pins a spec that no longer describes the API.
"""
import pathlib

import pytest
import yaml

from app.main import create_app

SPEC_PATH = (
    pathlib.Path(__file__).resolve().parents[3] / "siphon-api" / "gateway-openapi.yaml"
)


@pytest.mark.skipif(not SPEC_PATH.is_file(), reason="siphon-api checkout not present")
def test_published_spec_matches_generated_spec():
    published = yaml.safe_load(SPEC_PATH.read_text())
    generated = create_app(start_reconciler=False).openapi()

    pub_paths = set(published["paths"])
    gen_paths = set(generated["paths"])

    missing = gen_paths - pub_paths
    extra = pub_paths - gen_paths
    assert not missing, (
        f"routes exist in code but not in the published spec: {sorted(missing)} — "
        f"run scripts/export_openapi.py"
    )
    assert not extra, f"published spec declares routes that no longer exist: {sorted(extra)}"


@pytest.mark.skipif(not SPEC_PATH.is_file(), reason="siphon-api checkout not present")
def test_published_spec_covers_the_platform_surface():
    published = yaml.safe_load(SPEC_PATH.read_text())
    for path in (
        "/v1/operations/{id}",
        "/v1/webhook-endpoints",
        "/v1/subaccounts",
        "/v1/receipts/{id}/export",
        "/v1/batches",
        "/v1/policy",
    ):
        assert path in published["paths"], f"{path} missing from the published contract"


@pytest.mark.skipif(not SPEC_PATH.is_file(), reason="siphon-api checkout not present")
def test_published_spec_never_exposes_admin_routes():
    """Admin routes are include_in_schema=False; a published contract leaking them is a finding."""
    published = yaml.safe_load(SPEC_PATH.read_text())
    assert not [p for p in published["paths"] if "/admin/" in p]

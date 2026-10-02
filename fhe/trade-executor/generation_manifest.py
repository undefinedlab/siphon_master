"""Checksum-pinned canonical vault-generation manifest.

GENERATION_MANIFEST_PATH selects the manifest file and GENERATION_MANIFEST_SHA256 pins
its exact bytes. When configured, the manifest is the single source of truth for
generation lifecycle, entrypoints, and vault/tree addresses; environment values may only
agree with it, never override it. Any missing file, digest mismatch, or parse failure
raises ManifestError so callers fail closed.

This file is intentionally byte-identical wherever it is vendored (api-gateway,
trade-executor, siphon-asp); keep the copies in sync.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading

_lock = threading.Lock()
_cache: dict | None = None
_cache_key: tuple[str, str] | None = None


class ManifestError(Exception):
    """The manifest is configured but cannot be trusted; callers must fail closed."""


def configured() -> bool:
    return bool(os.getenv("GENERATION_MANIFEST_PATH", "").strip())


def load() -> dict:
    """Load, digest-verify, and cache the manifest."""
    global _cache, _cache_key
    path = os.getenv("GENERATION_MANIFEST_PATH", "").strip()
    digest = os.getenv("GENERATION_MANIFEST_SHA256", "").strip().lower()
    if not path:
        raise ManifestError("GENERATION_MANIFEST_PATH is not configured")
    if not digest:
        raise ManifestError("GENERATION_MANIFEST_SHA256 must pin the manifest digest")
    key = (path, digest)
    with _lock:
        if _cache is not None and _cache_key == key:
            return _cache
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError as exc:
            raise ManifestError(f"cannot read generation manifest: {exc}") from exc
        actual = hashlib.sha256(raw).hexdigest()
        if actual != digest:
            raise ManifestError(
                f"generation manifest digest mismatch: pinned {digest}, file {actual}"
            )
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise ManifestError(f"generation manifest is not valid JSON: {exc}") from exc
        generations = data.get("generations")
        if not isinstance(generations, list) or not generations:
            raise ManifestError("generation manifest has no generations")
        _cache = data
        _cache_key = key
        return data


def _generations() -> list[dict]:
    return [g for g in load().get("generations", []) if isinstance(g, dict)]


def active(chain_id: int) -> dict | None:
    """The full ACTIVE generation entry for a chain, or None when the chain is closed."""
    for gen in _generations():
        if int(gen.get("chainId", -1)) == int(chain_id) and gen.get("lifecycle") == "ACTIVE":
            return gen
    return None


def active_generation(chain_id: int) -> str | None:
    gen = active(chain_id)
    return (str(gen.get("generationId") or "") or None) if gen else None


def active_entrypoint(chain_id: int) -> str | None:
    gen = active(chain_id)
    return (str(gen.get("entrypoint") or "") or None) if gen else None


def exit_only_generations() -> set[str]:
    return {
        str(gen["generationId"])
        for gen in _generations()
        if gen.get("lifecycle") == "EXIT_ONLY" and gen.get("generationId")
    }

#!/usr/bin/env python
"""Export the gateway's generated OpenAPI to the published contract in siphon-api.

The gateway's contract is generated from its routers, which means the only copy that exists at rest
is whatever a running process serves. That is fine for a client fetching /openapi.json and useless
for review: nobody can diff a contract change in a pull request, and an integrator cannot pin a
version. This writes the spec into the siphon-api repo, where the executor's contract already lives.

    PYTHONPATH=.:../trade-executor python scripts/export_openapi.py [--check]

`--check` exits non-zero if the committed file is out of date, for CI.
"""
from __future__ import annotations

import argparse
import pathlib
import sys

import yaml

DEFAULT_OUT = pathlib.Path(__file__).resolve().parents[2].parent / "siphon-api" / "gateway-openapi.yaml"

SERVERS = [
    {"url": "https://api.siphon.money", "description": "Siphon Commercial API (gateway)"},
    {"url": "http://localhost:8000", "description": "Local gateway"},
]


def build() -> str:
    from app.main import create_app

    app = create_app(start_reconciler=False)
    spec = app.openapi()
    spec.setdefault("servers", SERVERS)
    return yaml.safe_dump(spec, sort_keys=True, width=100, default_flow_style=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true", help="fail if the committed spec is stale")
    args = ap.parse_args()

    rendered = build()

    if args.check:
        if not args.out.is_file():
            print(f"MISSING: {args.out}", file=sys.stderr)
            return 1
        if args.out.read_text() != rendered:
            print(
                f"STALE: {args.out} does not match the generated spec.\n"
                f"Run: PYTHONPATH=.:../trade-executor python scripts/export_openapi.py",
                file=sys.stderr,
            )
            return 1
        print(f"up to date: {args.out}")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(rendered)
    print(f"wrote {args.out} ({len(rendered)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

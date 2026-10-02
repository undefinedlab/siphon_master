"""One-shot: ensure strategy_legs.leg_kind exists (PIPELINE multi-hop)."""
from __future__ import annotations

import os
import sys

from sqlalchemy import create_engine, text


def main() -> int:
    uri = (
        os.environ.get("DATABASE_URI")
        or os.environ.get("DATABASE_URL")
        or os.environ.get("SQLALCHEMY_DATABASE_URI")
        or ""
    ).strip()
    if not uri:
        print("No DATABASE_URI/DATABASE_URL in env", file=sys.stderr)
        return 1
    eng = create_engine(uri)
    with eng.begin() as conn:
        cols = [
            r[0]
            for r in conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'strategy_legs'"
                )
            )
        ]
        print("strategy_legs columns:", ", ".join(sorted(cols)))
        if "leg_kind" in cols:
            print("leg_kind already present")
            return 0
        conn.execute(text("ALTER TABLE strategy_legs ADD COLUMN leg_kind VARCHAR(20)"))
        print("added strategy_legs.leg_kind")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

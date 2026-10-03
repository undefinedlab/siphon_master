"""Load OFAC sanctions snapshot into address_list."""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import config
from db import init_db, session, upsert_address

log = logging.getLogger("aspv2.seed_sanctions")


def seed_sanctions(path: Path | None = None) -> dict:
    init_db()
    seed_path = path or config.SEED_SANCTIONS_PATH
    if not seed_path.exists():
        raise FileNotFoundError(seed_path)
    data = json.loads(seed_path.read_text())
    addresses = data.get("addresses") or []
    source = data.get("source") or "ofac_snapshot"
    inserted = 0
    with session() as db:
        for row in addresses:
            addr = (row.get("address") or "").lower().strip()
            if not addr.startswith("0x") or len(addr) != 42:
                continue
            if upsert_address(
                db,
                address=addr,
                kind="sanction",
                source=source,
                entity_name=row.get("entity_name"),
                note=row.get("feature_type") or "snapshot",
            ):
                inserted += 1
        db.commit()
    return {"seed_path": str(seed_path), "rows": len(addresses), "sanction_inserted": inserted}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(seed_sanctions())

#!/usr/bin/env python3
"""
Verify a Supabase Cloud -> self-hosted note-DB migration.

Row counts are necessary but NOT sufficient. The thing that actually matters is that
`enc_blob` / `iv` survived byte-identical: the payloads are AES-GCM ciphertext, and a
count check would pass even if every blob were silently mangled by an encoding
round-trip (client_encoding, bytea vs text, a helpful editor). A mangled enc_blob is an
unrecoverable note, i.e. user funds lost — the protocol is non-custodial, so nobody can
restore them.

This script compares the two databases directly and reports any divergence.

    export CLOUD_DB_URI='postgresql://...'      # source (Supabase Cloud)
    export SELFHOST_DB_URI='postgresql://...'   # target (EC2)
    python3 scripts/verify_note_db_migration.py

Read-only: issues nothing but SELECT. Safe to run against production.

Exit 0 = identical. Exit 1 = divergence (details printed). Exit 2 = could not check.
"""
from __future__ import annotations

import hashlib
import os
import sys

try:
    import psycopg2
except ImportError:
    print("psycopg2 not installed:  pip install psycopg2-binary", file=sys.stderr)
    sys.exit(2)

# Tables that actually exist in the note database, worst-consequence first.
#
# NOT derived from note_db.py's models: that file declares four (commitments,
# precommitments, nullifier_registry, tag_verifiers) while the live database also carries
# wallet_keys and vault_registry — the latter drives generation filtering for balance
# display. Enumerating the source rather than trusting the models is what caught this;
# dumping from the model list alone would have silently dropped two tables.
TABLES = [
    "commitments",
    "precommitments",
    "wallet_keys",
    "nullifier_registry",
    "tag_verifiers",
    "vault_registry",
]

# Columns whose byte-exactness decides whether a note can still be decrypted.
# If these differ, the note is gone — this is the whole point of the script.
CRITICAL = {
    "commitments": ["id", "tag", "asset", "enc_blob", "iv", "spent"],
    "precommitments": ["id", "tag", "enc_blob", "iv"],
    "wallet_keys": ["id"],
    "nullifier_registry": ["id"],
    "tag_verifiers": ["id"],
    "vault_registry": ["id"],
}


def connect(uri: str, label: str):
    try:
        return psycopg2.connect(uri)
    except Exception as exc:
        print(f"cannot connect to {label}: {exc}", file=sys.stderr)
        sys.exit(2)


def existing_columns(conn, table: str) -> set[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
            (table,),
        )
        return {r[0] for r in cur.fetchall()}


def row_count(conn, table: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {table}")
        return cur.fetchone()[0]


def content_digest(conn, table: str, cols: list[str]) -> str:
    """
    Order-independent digest of the critical columns.

    Per-row hashes are sorted before folding, so a different physical row order (very
    likely after a dump/restore) does not register as a difference — only content does.
    """
    projection = " || '|' || ".join(f"coalesce({c}::text, '')" for c in cols)
    with conn.cursor() as cur:
        cur.execute(f"SELECT md5({projection}) FROM {table}")
        digests = sorted(r[0] for r in cur.fetchall())
    return hashlib.sha256("".join(digests).encode()).hexdigest()


def main() -> int:
    cloud_uri = os.environ.get("CLOUD_DB_URI", "")
    self_uri = os.environ.get("SELFHOST_DB_URI", "")
    if not cloud_uri or not self_uri:
        print("set CLOUD_DB_URI and SELFHOST_DB_URI", file=sys.stderr)
        return 2

    cloud = connect(cloud_uri, "CLOUD_DB_URI")
    selfhost = connect(self_uri, "SELFHOST_DB_URI")

    print(f"{'table':<22} {'cloud':>8} {'selfhost':>9}  content")
    print("-" * 60)

    failures: list[str] = []

    for table in TABLES:
        cloud_cols = existing_columns(cloud, table)
        self_cols = existing_columns(selfhost, table)

        if not cloud_cols:
            print(f"{table:<22} {'-':>8} {'-':>9}  MISSING on cloud (skipped)")
            continue
        if not self_cols:
            print(f"{table:<22} {'?':>8} {'-':>9}  ❌ MISSING on selfhost")
            failures.append(f"{table}: table absent on selfhost")
            continue

        # A column present on one side only would change the digest projection and
        # produce a confusing mismatch — surface it as its own finding.
        if cloud_cols != self_cols:
            only_cloud = sorted(cloud_cols - self_cols)
            only_self = sorted(self_cols - cloud_cols)
            failures.append(
                f"{table}: schema differs (cloud-only={only_cloud}, selfhost-only={only_self})"
            )

        n_cloud = row_count(cloud, table)
        n_self = row_count(selfhost, table)

        usable = [c for c in CRITICAL[table] if c in cloud_cols and c in self_cols]
        d_cloud = content_digest(cloud, table, usable)
        d_self = content_digest(selfhost, table, usable)

        if n_cloud != n_self:
            verdict = f"❌ ROW COUNT ({n_cloud - n_self:+d})"
            failures.append(f"{table}: row count {n_cloud} -> {n_self}")
        elif d_cloud != d_self:
            verdict = "❌ CONTENT DIFFERS"
            failures.append(
                f"{table}: identical row count but content digest differs — "
                f"enc_blob/iv likely mangled. DO NOT CUT OVER."
            )
        else:
            verdict = f"✅ match ({', '.join(usable)})"

        print(f"{table:<22} {n_cloud:>8} {n_self:>9}  {verdict}")

    print()
    if failures:
        print("MIGRATION NOT VERIFIED:")
        for f in failures:
            print(f"  - {f}")
        print(
            "\nDo not proceed to cutover. A content mismatch on commitments/precommitments\n"
            "means notes that cannot be decrypted — unrecoverable user funds."
        )
        return 1

    print("✅ All tables match on row count and critical-column content.")
    print(
        "\nStill required before cutover (this script cannot check them):\n"
        "  1. End-to-end decrypt test — real wallet, notes decrypt, balance matches.\n"
        "     Ciphertext parity proves transport; only a decrypt proves the KEY path.\n"
        "  2. A restored backup passing this same check (plans/…-supabase-self-host §5).\n"
        "  3. pg_cron prune job re-registered on the self-host."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

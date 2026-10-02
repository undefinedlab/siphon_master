#!/usr/bin/env python
"""Generate a shielded-keeper master secret for import as an encrypted CVM secret.

    python generate_master.py                 # writes keeper-master.secret (0600)
    python generate_master.py --show          # ALSO print it (air-gapped / write-it-down only)
    python generate_master.py --out /path.txt

This key is the single most valuable secret in the managed-accounts system. Everything derives from
it: every note's nullifier and secret, and every account's owner key. Two consequences, both
absolute:

* **Lose it and every managed note becomes underivable.** Not "hard to recover" — mathematically
  unrecoverable. Funds already deposited stay in the pool forever.
* **Leak it and every managed note is spendable by the holder.** It is equivalent to every private
  key of every account at once.

WHY THIS DOES NOT PRINT THE SECRET BY DEFAULT
---------------------------------------------
An earlier version printed the key and a ready-to-paste `phala cvms env set … KEEPER_MASTER_SECRET=0x…`
command. That leaks it three ways, all of them persistent:

1. **Shell history** — a pasted command lands in ~/.zsh_history or ~/.bash_history in plaintext and
   stays there.
2. **argv** — a secret passed as a command-line argument is visible in `ps` output to every other
   process and user on the machine while the command runs.
3. **Terminal scrollback, screen shares, CI logs** — anything written to stdout goes wherever the
   terminal goes.

So the secret is written to a 0600 file instead, and only the FINGERPRINT — which is non-reversible
and is the value you actually need to pin and compare — is printed.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import secrets
import stat


def master_fingerprint(master: bytes) -> str:
    """Must match app.master_fingerprint — this is what you pin and what /health reports."""
    return hashlib.sha256(b"keeper-master-fingerprint|" + master).hexdigest()[:32]


INSTRUCTIONS = """
================================================================================
  SHIELDED KEEPER — MASTER SECRET GENERATED
================================================================================

  Secret written to : {path}
                      (mode 0600 — readable only by you; NOT printed to stdout)

  Fingerprint       : {fingerprint}
                      (non-reversible; safe to record, commit and paste)

--------------------------------------------------------------------------------
  1. BACK IT UP OFFLINE, NOW — before deploying anything
--------------------------------------------------------------------------------
     At least two places, offline. There is no recovery path: if this key is
     lost, every managed note ever created becomes permanently unspendable.

--------------------------------------------------------------------------------
  2. IMPORT IT WITHOUT PUTTING IT IN SHELL HISTORY OR argv
--------------------------------------------------------------------------------
     Prefer a file- or stdin-based option if your CLI has one, e.g.

       phala cvms env set <cvm-id> --env-file {path}

     If it only accepts KEY=VALUE on the command line, avoid history and argv:

       set +o history                       # bash: stop recording
       phala cvms env set <cvm-id> "KEEPER_MASTER_SECRET=$(cat {path})"
       set -o history

     `$(cat …)` still passes the value through argv for the duration of the
     call. On a shared or CI machine, use the --env-file form instead.

     NEVER commit it, never put it in a compose file, never echo it.

--------------------------------------------------------------------------------
  3. PIN THE FINGERPRINT (safe to paste — it is not the key)
--------------------------------------------------------------------------------
       phala cvms env set <cvm-id> \\
         KEEPER_EXPECTED_MASTER_FINGERPRINT={fingerprint}

     The keeper REFUSES TO START if the loaded master does not match. That turns
     a silent, catastrophic key change into a loud startup failure.

--------------------------------------------------------------------------------
  4. SHRED THE LOCAL COPY once it is imported and backed up
--------------------------------------------------------------------------------
       shred -u {path}     # or: rm -P {path}   (macOS)

--------------------------------------------------------------------------------
  5. VERIFY, AND RE-VERIFY AFTER EVERY REDEPLOY
--------------------------------------------------------------------------------
       curl -s https://<keeper>/health | jq '.master_fingerprint, .enclave'

     master_fingerprint must equal the value above. If it changes, STOP — every
     existing managed note is underivable under the new key.

     "enclave": true requires BOTH an attested TEE and a non-dev master. Anything
     else means the host can read this key.
================================================================================
"""

SHOW_WARNING = """
  !! The secret is printed below because you passed --show.
  !! It is now in your terminal scrollback, and in shell history if you scroll.
  !! Only do this air-gapped, to write the key down on paper.

  KEEPER_MASTER_SECRET={secret}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path, default=pathlib.Path("keeper-master.secret"))
    ap.add_argument("--show", action="store_true",
                    help="also print the secret (air-gapped / write-it-down only)")
    args = ap.parse_args()

    if args.out.exists():
        print(f"REFUSING: {args.out} already exists. Move or shred it first — overwriting a master "
              f"secret that may already be in use would strand every note derived from it.")
        return 1

    master = secrets.token_bytes(32)

    # Create with 0600 from the outset: writing then chmod-ing leaves a window in which the file is
    # world-readable, and this is the one file where that window matters.
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w") as fh:
        fh.write("0x" + master.hex() + "\n")

    print(INSTRUCTIONS.format(path=args.out, fingerprint=master_fingerprint(master)))
    if args.show:
        print(SHOW_WARNING.format(secret="0x" + master.hex()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

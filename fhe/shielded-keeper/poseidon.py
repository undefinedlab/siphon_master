"""Variable-arity BN254 Poseidon, matching circomlib / circomlibjs exactly.

The keeper needs Poseidon(1) for `nullifierHash` and Poseidon(2) for everything else.
`siphon-asp/poseidon_t3.py` is proven but its node bridge is hard-wired to 2 inputs, so this is a
local variable-arity version using the same persistent-subprocess design — a one-shot `node -e` per
hash is what caused the 45s `/set/path` stall the ASP already had to fix.

Correctness is not negotiable here: a Poseidon that disagrees with the circuit by one bit produces a
commitment the circuit cannot reproduce, and the deposit becomes permanently unwithdrawable. Hence:

* circomlibjs (the exact library the circuits compile against) is the ONLY accepted backend;
* there is deliberately no pure-Python fallback — a "close enough" hash that silently mints
  unspendable notes is far worse than an outage;
* `self_test()` checks known vectors at startup and refuses to serve if they do not match.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import subprocess
import threading
from pathlib import Path

log = logging.getLogger("keeper.poseidon")

FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617

_ROOT = Path(__file__).resolve().parent
_CANDIDATES = [
    _ROOT.parent.parent / "siphon-zk" / "node_modules" / "circomlibjs",
    _ROOT / "node_modules" / "circomlibjs",
]

_process: subprocess.Popen | None = None
_lock = threading.Lock()


def _find_circomlibjs() -> Path | None:
    env = os.getenv("KEEPER_CIRCOMLIBJS")
    if env and Path(env).is_dir():
        return Path(env)
    for c in _CANDIDATES:
        if c.is_dir():
            return c
    return None


def _start_bridge(lib: Path) -> subprocess.Popen:
    script = f"""
const readline = require("readline");
const {{ buildPoseidon }} = require({json.dumps(str(lib))});
(async () => {{
  const p = await buildPoseidon();
  const F = p.F;
  const rl = readline.createInterface({{ input: process.stdin, crlfDelay: Infinity }});
  rl.on("line", line => {{
    try {{
      const inputs = JSON.parse(line).map(BigInt);
      process.stdout.write(F.toObject(p(inputs)).toString() + "\\n");
    }} catch (error) {{
      process.stdout.write("ERR " + String(error) + "\\n");
    }}
  }});
}})().catch(error => {{ console.error(error); process.exit(1); }});
"""
    return subprocess.Popen(
        ["node", "-e", script],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
    )


def _stop_bridge() -> None:
    global _process
    proc, _process = _process, None
    if proc is not None and proc.poll() is None:
        proc.terminate()


atexit.register(_stop_bridge)


def poseidon(inputs: list[int]) -> int:
    """Poseidon over 1..n field elements. Arity is inferred from len(inputs), as in circomlib."""
    global _process
    if not inputs:
        raise ValueError("poseidon requires at least one input")

    lib = _find_circomlibjs()
    if lib is None:
        raise RuntimeError(
            "circomlibjs not found — install siphon-zk node_modules or set KEEPER_CIRCOMLIBJS. "
            "Refusing to hash with a substitute: a mismatched Poseidon mints unspendable notes."
        )

    payload = json.dumps([str(int(x) % FIELD_SIZE) for x in inputs])
    with _lock:
        if _process is None or _process.poll() is not None:
            _process = _start_bridge(lib)
        proc = _process
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(payload + "\n")
        proc.stdin.flush()
        out = proc.stdout.readline().strip()
        if not out:
            err = proc.stderr.read().strip() if proc.stderr is not None else ""
            _stop_bridge()
            raise RuntimeError(f"poseidon bridge exited: {err}")
        if out.startswith("ERR "):
            raise RuntimeError(f"poseidon failed: {out[4:]}")
        return int(out) % FIELD_SIZE


def poseidon1(x: int) -> int:
    return poseidon([x])


def poseidon2(a: int, b: int) -> int:
    return poseidon([a, b])


# --- protocol scheme (circuits/commitment.circom, circuits/withdrawal.circom) ----------------

def precommitment_hash(nullifier: int, secret: int) -> int:
    """precommitment = Poseidon(nullifier, secret)"""
    return poseidon2(nullifier, secret)


def commitment_hash(amount: int, label: int, precommitment: int) -> int:
    """commitment = Poseidon(Poseidon(amount, label), precommitment)  — nested, Hard ASP era."""
    return poseidon2(poseidon2(amount, label), precommitment)


def nullifier_hash(nullifier: int) -> int:
    """nullifierHash = Poseidon(nullifier)  — ARITY 1, not 2. See withdrawal.circom:83-85."""
    return poseidon1(nullifier)


def label_hash(scope: int, nonce: int) -> int:
    """label = Poseidon(scope, nonce); scope is uint160(vault) as a field element."""
    return poseidon2(scope, nonce)


# --- startup guard ---------------------------------------------------------------------------

# Vectors captured from circomlibjs itself (see tests/test_poseidon_vectors.py, which regenerates
# them). If these ever stop matching, the backend changed underneath us and every note derived from
# it would be unspendable — so the keeper refuses to start rather than mint bad commitments.
KNOWN_VECTORS: dict[str, str] = {
    "poseidon1(1)": "18586133768512220936620570745912940619677854269274689475585506675881198879027",
    "poseidon2(1,2)": "7853200120776062878684798364095072458815029376092732009249414926327459813530",
}


def self_test() -> None:
    got1 = str(poseidon1(1))
    got2 = str(poseidon2(1, 2))
    if got1 != KNOWN_VECTORS["poseidon1(1)"] or got2 != KNOWN_VECTORS["poseidon2(1,2)"]:
        raise RuntimeError(
            "Poseidon self-test FAILED — backend disagrees with the circuits.\n"
            f"  poseidon1(1) = {got1}\n  expected     = {KNOWN_VECTORS['poseidon1(1)']}\n"
            f"  poseidon2(1,2) = {got2}\n  expected       = {KNOWN_VECTORS['poseidon2(1,2)']}\n"
            "Refusing to derive notes: mismatched hashes mint unspendable commitments."
        )
    log.info("poseidon self-test ok (circomlibjs)")

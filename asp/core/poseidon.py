"""PoseidonT3 (2-arity) — circomlib / zkv2 fixture parity."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import atexit
from functools import lru_cache
from pathlib import Path

log = logging.getLogger("aspv2.poseidon")

SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617
_FIELD = SNARK_SCALAR_FIELD
_ROOT = Path(__file__).resolve().parents[1]
_NODE_PROCESS: subprocess.Popen[str] | None = None
_NODE_LOCK = threading.Lock()


def field_mod(value: int | str) -> int:
    return int(value) % _FIELD


def _is_allowed_circomlibjs(path: Path) -> bool:
    """F-5: only allow …/node_modules/circomlibjs (resolved)."""
    try:
        resolved = path.resolve()
    except OSError:
        return False
    if not resolved.is_dir():
        return False
    # Must be named circomlibjs and live under a node_modules directory.
    if resolved.name != "circomlibjs":
        return False
    return resolved.parent.name == "node_modules"


def _find_circomlibjs() -> Path | None:
    env = os.getenv("ASP_CIRCOMLIBJS")
    if env:
        candidate = Path(env)
        if _is_allowed_circomlibjs(candidate):
            return candidate.resolve()
        log.warning("ASP_CIRCOMLIBJS rejected (must be …/node_modules/circomlibjs): %s", env)
    local = _ROOT / "node_modules" / "circomlibjs"
    if _is_allowed_circomlibjs(local):
        return local.resolve()
    for sibling in ("siphon-zkv2", "siphon-zk"):
        candidate = _ROOT.parent / sibling / "node_modules" / "circomlibjs"
        if _is_allowed_circomlibjs(candidate):
            return candidate.resolve()
    return None


def _start_node_bridge(lib: Path) -> subprocess.Popen[str]:
    script = f"""
const readline = require("readline");
const {{ buildPoseidon }} = require({json.dumps(str(lib))});
(async () => {{
  const p = await buildPoseidon();
  const F = p.F;
  const rl = readline.createInterface({{ input: process.stdin, crlfDelay: Infinity }});
  rl.on("line", line => {{
    try {{
      const inputs = JSON.parse(line);
      const out = p(inputs.map(x => BigInt(x)));
      process.stdout.write(F.toObject(out).toString() + "\\n");
    }} catch (error) {{
      process.stdout.write("ERR " + String(error) + "\\n");
    }}
  }});
}})().catch(error => {{ console.error(error); process.exit(1); }});
"""
    return subprocess.Popen(
        ["node", "-e", script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def _stop_node_bridge() -> None:
    global _NODE_PROCESS
    process, _NODE_PROCESS = _NODE_PROCESS, None
    if process is not None and process.poll() is None:
        process.terminate()


atexit.register(_stop_node_bridge)


def _node_poseidon(inputs: list[int]) -> int:
    global _NODE_PROCESS
    lib = _find_circomlibjs()
    if lib is None:
        raise RuntimeError("circomlibjs not found — run npm install in siphon-aspv2")
    with _NODE_LOCK:
        if _NODE_PROCESS is None or _NODE_PROCESS.poll() is not None:
            _NODE_PROCESS = _start_node_bridge(lib)
        process = _NODE_PROCESS
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(json.dumps([str(x) for x in inputs]) + "\n")
        process.stdin.flush()
        result = process.stdout.readline().strip()
        if not result:
            stderr = process.stderr.read().strip() if process.stderr is not None else ""
            _stop_node_bridge()
            raise RuntimeError(f"node poseidon bridge exited: {stderr}")
        if result.startswith("ERR "):
            raise RuntimeError(result[4:])
        return int(result) % _FIELD


@lru_cache(maxsize=1)
def _warmup():
    if _find_circomlibjs() is not None:
        _node_poseidon([0, 0])
        log.info("Poseidon via circomlibjs")
        return True
    raise RuntimeError(
        "No Poseidon backend: cd siphon-aspv2 && npm install, or set ASP_CIRCOMLIBJS"
    )


def hash_inputs(*values: int | str) -> int:
    _warmup()
    return _node_poseidon([field_mod(v) for v in values])


def hash2(left: int | str, right: int | str) -> int:
    return hash_inputs(left, right)

import os
from dotenv import load_dotenv

load_dotenv()

PORT           = int(os.getenv('PROVING_RELAYER_PORT', 5010))
ZK_BUILD_DIR   = os.getenv('ZK_BUILD_DIR', '../../siphon-zk/circuits/build')
RAPIDSNARK_BIN = os.getenv('RAPIDSNARK_BIN', 'rapidsnark')
NODE_BIN       = os.getenv('NODE_BIN', 'node')
SNARKJS_BIN    = os.getenv('SNARKJS_BIN', 'snarkjs')

VALID_CIRCUITS = {
    'w1', 'w2', 'w3', 'w4', 'w5', 'w6',
    'm2', 'm3', 'm4', 'm5', 'm6',
    'swap', 'split', 'ragequit',
}

def circuit_paths(circuit: str) -> tuple[str, str]:
    """Return (wasm_path, zkey_path) for a circuit, in the flat browser-bundle layout
    (`<circuit>/main_<circuit>.wasm` + `<circuit>/zkey_final.zkey`) — the SAME artifacts the
    frontend proves with, so proofs verify against the deployed on-chain verifiers. Witness
    generation uses `snarkjs wtns calculate` (wasm-only), so no generate_witness.js is needed."""
    if circuit not in VALID_CIRCUITS:
        raise ValueError(f"Unknown circuit '{circuit}'. Valid: {sorted(VALID_CIRCUITS)}")
    prefix = f'main_{circuit}'
    return (
        os.path.join(ZK_BUILD_DIR, circuit, f'{prefix}.wasm'),
        os.path.join(ZK_BUILD_DIR, circuit, 'zkey_final.zkey'),
    )

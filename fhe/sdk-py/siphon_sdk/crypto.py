import os

FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617


def generate_random_field_element() -> int:
    return int.from_bytes(os.urandom(32), "big") % FIELD_SIZE


def generate_note(chain_id: int, asset: str, amount: str) -> dict:
    # The note commitment MUST be BN254 circom Poseidon (commitment = Poseidon(amount,
    # Poseidon(nullifier, secret))) — the same hash the circuits + on-chain Merkle tree enforce
    # (see siphon-app/src/lib/zkHandler.ts, the reference impl in the TS SDK). A mismatched hash
    # produces a leaf the circuit can't reproduce -> the deposit can never be withdrawn (funds lost).
    #
    # There is no verified BN254-circom Poseidon on PyPI (poseidon-py is the Starknet variant, wrong
    # field/params). Rather than ship a second incompatible hash, fail loud: use the TS SDK for note
    # generation until a Poseidon impl is proven byte-compatible against zkHandler.ts test vectors.
    raise NotImplementedError(
        "generate_note: BN254 circom Poseidon is not yet available in the Python SDK. "
        "Use the TypeScript SDK (packages/sdk-ts) for note generation, or wire a Poseidon "
        "implementation verified against siphon-app/src/lib/zkHandler.ts before enabling this."
    )


def generate_fhe_key_pair() -> dict:
    client_key = os.urandom(32).hex()
    server_key = os.urandom(32).hex()
    return {
        "client_key": client_key,
        "server_key": server_key,
    }


def encrypt_value_fhe(client_key: str, value: int) -> str:
    # TFHE (Zama) client-side encryption is a wasm subsystem (spec §13) not yet ported to the SDK.
    # Fail loud: a stand-in hash/ciphertext the FHE engine would misread is a latent trap.
    raise NotImplementedError(
        "encrypt_value_fhe: client-side TFHE encryption is not yet implemented in the Python SDK. "
        "Encrypt strategy bounds via the TFHE wasm path (see siphon-app/src/lib/fhe.ts)."
    )

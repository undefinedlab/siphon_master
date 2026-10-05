import crypto from "crypto";
import { buildPoseidon } from "circomlibjs";

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface NoteSecrets {
  nullifier: string;
  secret: string;
  precommitment: string;
  commitment: string;
  nullifierHash: string;
}

// The commitment scheme is enforced by the circuits + on-chain Merkle tree: it MUST be the same
// BN254 Poseidon the protocol uses (see siphon-app/src/lib/zkHandler.ts). A SHA256 substitute
// produces a leaf the circuit can't reproduce -> the deposit can never be withdrawn (funds lost).
let _poseidon: any = null;
async function getPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}

/** Real BN254 Poseidon hash — matches zkHandler.ts (`F.toObject(poseidon([...]))`). */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  return BigInt(F.toObject(poseidon(inputs.map((x) => x % FIELD_SIZE))));
}

export function generateRandomFieldElement(): bigint {
  const bytes = crypto.randomBytes(32);
  return BigInt("0x" + bytes.toString("hex")) % FIELD_SIZE;
}

export async function generateNote(chainId: number, asset: string, amount: string): Promise<NoteSecrets> {
  const nullifier = generateRandomFieldElement();
  const secret = generateRandomFieldElement();
  const amountBig = BigInt(amount);

  const precommitment = await poseidonHash([nullifier, secret]);
  const commitment = await poseidonHash([amountBig, precommitment]);
  const nullifierHash = await poseidonHash([nullifier]);

  return {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    precommitment: precommitment.toString(),
    commitment: commitment.toString(),
    nullifierHash: nullifierHash.toString(),
  };
}

export interface FheKeyPair {
  clientKey: string;
  serverKey: string;
}

export function generateFheKeyPair(): FheKeyPair {
  const clientKeyBytes = crypto.randomBytes(32);
  const serverKeyBytes = crypto.randomBytes(32);
  return {
    clientKey: clientKeyBytes.toString("hex"),
    serverKey: serverKeyBytes.toString("hex"),
  };
}

export function encryptValueFhe(_clientKey: string, _value: number): string {
  // TFHE (Zama) client-side encryption is a wasm subsystem (spec §13) not yet ported to the SDK.
  // Fail loud: silently returning AES ciphertext the FHE engine would misread is a latent trap.
  throw new Error(
    "encryptValueFhe: client-side TFHE encryption is not yet implemented in the SDK. " +
      "Encrypt strategy bounds via the TFHE wasm path (see siphon-app/src/lib/fhe.ts)."
  );
}

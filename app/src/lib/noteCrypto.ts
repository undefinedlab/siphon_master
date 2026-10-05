/**
 * Hard ASP note hashing — matches CommitmentLib.sol / commitment.circom.
 *
 *   precommitment = Poseidon(nullifier, secret)
 *   label         = Poseidon(scope, depositNonce)   // scope = uint160(vault)
 *   commitment    = Poseidon(Poseidon(amount, label), precommitment)
 */
// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();

const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function modField(x: bigint): bigint {
  const r = x % FIELD;
  return r < 0n ? r + FIELD : r;
}

type PoseidonFn = {
  (inputs: bigint[]): unknown;
  F: { toObject: (x: unknown) => bigint | string };
};

let _poseidon: PoseidonFn | null = null;

export async function getPoseidon(): Promise<PoseidonFn> {
  if (_poseidon) return _poseidon;
  _poseidon = (await buildPoseidon()) as PoseidonFn;
  return _poseidon;
}

export async function poseidon2(a: bigint, b: bigint): Promise<bigint> {
  const p = await getPoseidon();
  return BigInt(p.F.toObject(p([modField(a), modField(b)])));
}

export async function poseidon1(a: bigint): Promise<bigint> {
  const p = await getPoseidon();
  return BigInt(p.F.toObject(p([modField(a)])));
}

export async function hashLabel(scope: bigint, nonce: bigint): Promise<bigint> {
  return poseidon2(scope, nonce);
}

export async function hashCommitment(
  amountWei: bigint,
  label: bigint,
  precommitment: bigint,
): Promise<bigint> {
  const inner = await poseidon2(amountWei, label);
  return poseidon2(inner, precommitment);
}

export async function hashPrecommitment(nullifier: bigint, secret: bigint): Promise<bigint> {
  return poseidon2(nullifier, secret);
}

/** Vault scope used on-chain: uint256(uint160(vault)). */
export function vaultScope(vaultAddress: string): bigint {
  return BigInt(vaultAddress.toLowerCase());
}

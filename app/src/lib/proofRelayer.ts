import { Signer } from 'ethers';
// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { proofToCalldata } from './generateProof';

const PROVE_URL = '/api/prove';

export async function prepareWithdrawalTransactionRemote(params: {
  existingValue: string;
  existingNullifier: string;
  existingSecret: string;
  withdrawnValue: string;
  newNullifier: string;
  newSecret: string;
  pathElements: string[];
  pathIndices: number[];
  recipient: string;
  stateRoot: string;
}, signer: Signer) {
  void signer;

  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const existingNullifier = BigInt(params.existingNullifier);
  const newNullifier      = BigInt(params.newNullifier);
  const newSecret         = BigInt(params.newSecret);
  const existingValue     = BigInt(params.existingValue);
  const withdrawnValue    = BigInt(params.withdrawnValue);
  const remainingValue    = existingValue - withdrawnValue;

  const nullifierHash    = F.toString(poseidon([existingNullifier]));
  const newPrecommitment = F.toString(poseidon([newNullifier, newSecret]));
  const newCommitment    = F.toString(poseidon([remainingValue, newPrecommitment]));
  const recipientField   = BigInt(params.recipient).toString();

  const inputs = {
    withdrawnValue:    params.withdrawnValue,
    stateRoot:         params.stateRoot,
    newCommitment,
    nullifierHash,
    recipient:         recipientField,
    existingValue:     params.existingValue,
    existingNullifier: params.existingNullifier,
    existingSecret:    params.existingSecret,
    newNullifier:      params.newNullifier,
    newSecret:         params.newSecret,
    pathElements:      params.pathElements.map(String),
    pathIndices:       params.pathIndices,
  };

  const res = await fetch(PROVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Proving relayer failed: ${err.error || res.status}`);
  }

  const { proof, publicSignals } = await res.json();
  const { pA, pB, pC } = proofToCalldata(proof);

  return {
    recipient:     params.recipient,
    amount:        params.withdrawnValue,
    nullifierHash,
    newCommitment,
    stateRoot:     params.stateRoot,
    pA: pA as [string, string],
    pB: pB as [[string, string], [string, string]],
    pC: pC as [string, string],
    publicSignals,
  };
}

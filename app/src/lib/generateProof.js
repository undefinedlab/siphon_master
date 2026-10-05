import * as snarkjs from 'snarkjs';
import { zkUrl } from "./zkAssets";

/**
 * LEGACY soft-era entrypoint — removed (ZK-03).
 * Hard ASP withdraws use prepareWithdrawalTransactionMulti / wN circuits via zkHandler.
 */
export async function generateWithdrawalProof(_withdrawalData) {
  throw new Error(
    "generateWithdrawalProof is removed — use prepareWithdrawalTransactionMulti (w1–w6) via zkHandler",
  );
}

/**
 * Convert Groth16 proof to Solidity pA / pB / pC calldata format.
 * snarkjs groth16 proof fields: pi_a, pi_b, pi_c
 * BN254 G2 points: snarkjs gives [x[0], x[1]] as [c0, c1]; Solidity verifier expects [c1, c0].
 */
export function proofToCalldata(proof) {
  const str = v => BigInt(v).toString();

  return {
    pA: [str(proof.pi_a[0]), str(proof.pi_a[1])],
    pB: [
      [str(proof.pi_b[0][1]), str(proof.pi_b[0][0])],
      [str(proof.pi_b[1][1]), str(proof.pi_b[1][0])],
    ],
    pC: [str(proof.pi_c[0]), str(proof.pi_c[1])],
  };
}

/**
 * Verify proof locally against a circuit-specific verification key before submitting on-chain.
 * Pass circuit folder name (e.g. "w1", "swap") — never a shared /zk/verification_key.json.
 */
export async function verifyProofLocally(proof, publicSignals, circuit) {
  if (!circuit || typeof circuit !== "string") {
    throw new Error("verifyProofLocally requires a circuit id (e.g. w1, swap)");
  }
  try {
    const vKey = await fetch(zkUrl(`/zk/${circuit}/verification_key.json`)).then(r => {
      if (!r.ok) throw new Error(`vk HTTP ${r.status}`);
      return r.json();
    });
    const isValid = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    console.log("[generateProof] Local verification:", isValid ? "Valid" : "Invalid");
    return isValid;
  } catch (err) {
    console.error("[generateProof] Local verification error:", err);
    return false;
  }
}

function _normaliseProof(proof) {
  return {
    pA: [proof.pi_a[0].toString(), proof.pi_a[1].toString()],
    pB: [
      [proof.pi_b[0][1].toString(), proof.pi_b[0][0].toString()],
      [proof.pi_b[1][1].toString(), proof.pi_b[1][0].toString()],
    ],
    pC: [proof.pi_c[0].toString(), proof.pi_c[1].toString()],
  };
}

/** Attach request-bound Siphon auth so /api/prove is not an open relayer (OMEGA-01). */
async function _proveAuthHeaders(bodyText) {
  try {
    const { getSigner } = await import('./nexus');
    const { getPrivilegedWalletAuthHeaders } = await import('./walletAuthHeaders');
    const signer = getSigner();
    if (!signer) return { headers: { 'Content-Type': 'application/json' }, signer: null };
    const headers = await getPrivilegedWalletAuthHeaders(
      signer,
      'POST',
      '/api/prove',
      bodyText,
    );
    return { headers, signer };
  } catch {
    return { headers: { 'Content-Type': 'application/json' }, signer: null };
  }
}

async function _proveViaNextApi(circuitInput, circuit) {
  const bodyText = JSON.stringify({ inputs: circuitInput, circuit });
  const auth = await _proveAuthHeaders(bodyText);
  const post = async (headers) =>
    fetch('/api/prove', {
      method: 'POST',
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(120_000),
    });

  let res = await post(auth.headers);
  if (res.status === 401 && auth.signer) {
    const errBody = await res.clone().json().catch(() => ({}));
    if (errBody.error === 'wallet_auth_expired' || errBody.error === 'wallet_auth_invalid') {
      const retry = await _proveAuthHeaders(bodyText);
      res = await post(retry.headers);
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`/api/prove error (${circuit}): ${err.error || res.status}`);
  }
  const { proof, publicSignals } = await res.json();
  return { proof: _normaliseProof(proof), publicSignals };
}

async function _proveLocally(circuitInput, circuit) {
  // Swap circuit lives at /zk/swap (Hard ASP: 11 pub signals).
  if (circuit === 'swap') {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      zkUrl(`/zk/swap/main_swap.wasm`),
      zkUrl(`/zk/swap/zkey_final.zkey`),
    );
    return { proof: _normaliseProof(proof), publicSignals };
  }
  // Split circuit lives at /zk/split (Hard ASP: 19 pub signals).
  if (circuit === 'split') {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      zkUrl(`/zk/split/main_split.wasm`),
      zkUrl(`/zk/split/zkey_final.zkey`),
    );
    return { proof: _normaliseProof(proof), publicSignals };
  }
  const isWithdraw = circuit.startsWith('w');
  const N = parseInt(circuit.slice(1), 10);
  const prefix = isWithdraw ? 'w' : 'm';
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    zkUrl(`/zk/${prefix}${N}/main_${prefix}${N}.wasm`),
    zkUrl(`/zk/${prefix}${N}/zkey_final.zkey`),
  );
  return { proof: _normaliseProof(proof), publicSignals };
}

/**
 * Route proof generation (OMEGA-04):
 * - Default: browser snarkjs (witnesses stay local).
 * - Opt-in remote: NEXT_PUBLIC_ALLOW_REMOTE_PROVE=1 → /api/prove then local fallback.
 * Never POST witnesses to NEXT_PUBLIC_PROVING_RELAYER_URL — that bypassed Next auth.
 */
async function _prove(circuitInput, circuit) {
  const t0 = Date.now();
  console.log(`[generateProof] Proving ${circuit.toUpperCase()}...`);

  const allowRemote =
    (typeof process !== 'undefined' &&
      (process.env.NEXT_PUBLIC_ALLOW_REMOTE_PROVE || '').trim() === '1');

  let result;
  if (allowRemote) {
    try {
      result = await _proveViaNextApi(circuitInput, circuit);
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`[generateProof] /api/prove failed, falling back to snarkjs: ${msg}`);
      result = await _proveLocally(circuitInput, circuit);
    }
  } else {
    result = await _proveLocally(circuitInput, circuit);
  }

  console.log(`[generateProof] ${circuit.toUpperCase()} proof in ${Date.now() - t0}ms`);
  return result;
}

/**
 * Multi-note withdrawal proof (N=1..6).
 */
export async function prepareWithdrawalTransactionMulti(circuitInput, N) {
  return _prove(circuitInput, `w${N}`);
}

/**
 * Merge proof (N=2..6).
 */
export async function prepareMergeTransaction(circuitInput, N) {
  return _prove(circuitInput, `m${N}`);
}

/**
 * Atomic swap proof. Local snarkjs by default (OMEGA-04); remote only when
 * NEXT_PUBLIC_ALLOW_REMOTE_PROVE=1.
 */
export async function prepareSwapTransaction(circuitInput) {
  return _prove(circuitInput, 'swap');
}

/**
 * Split proof (1 note → 8 slice notes). Browser snarkjs (server prover has no split circuit).
 */
export async function prepareSplitTransaction(circuitInput) {
  const t0 = Date.now();
  console.log('[generateProof] Proving SPLIT (browser snarkjs)...');
  const result = await _proveLocally(circuitInput, 'split');
  console.log(`[generateProof] SPLIT proof in ${Date.now() - t0}ms`);
  return result;
}

/**
 * Ragequit proof (Hard ASP escape hatch). Browser snarkjs — 6 public signals.
 */
export async function prepareRagequitTransaction(circuitInput) {
  const t0 = Date.now();
  console.log('[generateProof] Proving RAGEQUIT (browser snarkjs)...');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    zkUrl(`/zk/ragequit/main_ragequit.wasm`),
    zkUrl(`/zk/ragequit/zkey_final.zkey`),
  );
  console.log(`[generateProof] RAGEQUIT proof in ${Date.now() - t0}ms`);
  return { proof: _normaliseProof(proof), publicSignals };
}

/**
 * LEGACY soft-era pipeline — removed (ZK-03). Use prepareWithdrawalTransactionMulti.
 */
export async function prepareWithdrawalTransaction(_params) {
  throw new Error(
    "prepareWithdrawalTransaction is removed — use prepareWithdrawalTransactionMulti via zkHandler",
  );
}

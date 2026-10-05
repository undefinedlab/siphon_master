/**
 * MPC-shaped seal API for private multi-hop Solana pipelines.
 *
 * sealPipelineBundle / provePipelineHop stay stable; today's mock TEE decrypts via the
 * decryptor-mock and proves with snarkjs. A future MPC prover swaps the implementation only.
 */
import { attestAndSeal, isMockTeeAllowed } from "@/lib/decryptorAttestation";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";

export type PipelineHopSecrets = {
  nullifier: string;
  secret: string;
  userSalt: string;
  precommitment: string;
};

export type PipelineNoteBundle = {
  version: 1;
  hops: PipelineHopSecrets[];
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Seal a PipelineNoteBundle to the attested decryptor enclave (or mock TEE when allowed).
 * Returns hex(crypto_box_seal(utf8(JSON), enclave_pubkey)).
 */
export async function sealPipelineBundle(
  bundle: PipelineNoteBundle,
  executorBase: string = getTradeExecutorBaseUrl(),
): Promise<string> {
  if (!bundle.hops.length) throw new Error("pipeline bundle needs at least one hop");
  for (let i = 0; i < bundle.hops.length; i++) {
    const h = bundle.hops[i];
    if (!h.nullifier || !h.secret || !h.userSalt || !h.precommitment) {
      throw new Error(`pipeline hop ${i} is missing note secrets`);
    }
  }
  const utf8 = new TextEncoder().encode(JSON.stringify(bundle));
  return attestAndSeal(bytesToHex(utf8), executorBase);
}

export type PipelineHopPublicContext = {
  returned_note: {
    commitment: string;
    amount: string;
    mint: string;
    leaf_index: string | number;
    deposit_nonce?: string;
    deposit_sig?: string | null;
  };
  settlement: string;
  venue: Record<string, unknown>;
  /** Hop whose return secrets become this spend's inputs (previous hop). */
  input_hop_index: number;
  /** Hop whose return secrets are attached for the next deposit. */
  return_hop_index: number;
};

/**
 * Ask the executor/TEE to prove the next pipeline hop. Returns a venue spend package.
 */
export async function provePipelineHop(
  strategyId: string,
  hopIndex: number,
  publicContext: PipelineHopPublicContext,
  executorBase: string = getTradeExecutorBaseUrl(),
): Promise<Record<string, unknown>> {
  const res = await fetch(`${executorBase}/pipeline/prove-hop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy_id: strategyId,
      hop_index: hopIndex,
      public_context: publicContext,
      mock_tee: isMockTeeAllowed(),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    package?: Record<string, unknown>;
  };
  if (!res.ok || !body.ok || !body.package) {
    throw new Error(body.error || `provePipelineHop failed (HTTP ${res.status})`);
  }
  return body.package;
}

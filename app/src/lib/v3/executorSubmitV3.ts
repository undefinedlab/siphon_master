/**
 * Executor submission hook implementation for v3 spend actions.
 * POSTs spend payload ({ chain_id, public_inputs, proof, extra }) to the
 * trade-executor's POST /relaySpend endpoint using write-auth headers (getWalletWriteAuthHeaders).
 * The trade-executor resolves the vault_kernel contract address strictly from trusted server config.
 */

import { Signer } from "ethers";
import { getTradeExecutorBaseUrl } from "../tradeExecutorClient";
import { getWalletWriteAuthHeaders } from "../walletAuthHeaders";
import type { Groth16Calldata } from "./withdrawV3";
import type { ComplianceHalf } from "./complianceProofV3";

/**
 * The relayer wants its prepaid withdrawal fee. Distinct from a real submission failure: the proof
 * is valid, and the withdrawal can still be made either by topping up or by calling
 * VaultKernel.spend() directly, which is permissionless by design.
 */
export class WithdrawCreditRequiredError extends Error {
  readonly requiredWei: bigint;
  readonly balanceWei: bigint;
  constructor(requiredWei: string, balanceWei: string) {
    super("Relay fee unpaid — top up your withdrawal credit, or submit the proof yourself.");
    this.name = "WithdrawCreditRequiredError";
    this.requiredWei = BigInt(requiredWei || "0");
    this.balanceWei = BigInt(balanceWei || "0");
  }
}


/**
 * Flatten a Groth16 proof to the `uint256[8]` the kernel actually takes.
 *
 * proofToCalldata() produces the structured {pA, pB, pC} form, and all five spend paths pass it
 * straight through — but VaultKernel.spend takes `uint256[8]`, and the router unpacks it as:
 *
 *     [proof[0], proof[1]], [[proof[2], proof[3]], [proof[4], proof[5]]], [proof[6], proof[7]]
 *
 * so the wire shape is a flat row-major eight. /relaySpend mirrors that ABI and rejected the
 * structured object with "proof must be a list of 8 values". Normalising here rather than at each
 * call site means a new spend action cannot reintroduce the mismatch.
 *
 * The G2 coordinate swap is already applied by proofToCalldata; this only flattens.
 */
function flattenGroth16Proof(proof: unknown): string[] {
  if (Array.isArray(proof)) {
    if (proof.length !== 8) {
      throw new Error(`flattenGroth16Proof: expected 8 values, got ${proof.length}`);
    }
    return proof.map((v) => BigInt(v as string | number | bigint).toString());
  }

  const p = proof as { pA?: string[]; pB?: string[][]; pC?: string[] };
  if (!p?.pA || !p?.pB || !p?.pC) {
    throw new Error("flattenGroth16Proof: expected {pA, pB, pC} or a flat 8-element array");
  }
  const flat = [
    p.pA[0], p.pA[1],
    p.pB[0][0], p.pB[0][1],
    p.pB[1][0], p.pB[1][1],
    p.pC[0], p.pC[1],
  ];
  if (flat.some((v) => v === undefined)) {
    throw new Error("flattenGroth16Proof: malformed proof point");
  }
  return flat.map((v) => BigInt(v).toString());
}

export interface ExecutorSubmitPayload {
  chainId: number;
  vaultKernel?: string;
  publicInputs: string[];
  proof: Groth16Calldata;
  /**
   * The COMPLIANCE half (PROGRAM_VERSION 5). The kernel verifies it conjunctively with the spend
   * proof, so a payload without it reverts ComplianceProofFailed() — the relayer pays the gas and
   * the user sees a 502. Optional in the type only so a RAGEQUIT caller may omit it; every other
   * action must send one.
   */
  compliance?: ComplianceHalf;
  rawPayee?: string;
  extra?: Record<string, unknown>;
}

/**
 * `path`/`extraBody`/`onResponse` let /bridgeWithdraw reuse this exactly: its body is the
 * /relaySpend body plus `bridge`, and its 200 carries the order id the caller needs to poll.
 */
export function createExecutorSubmitV3(
  signer: Signer,
  opts: {
    path?: string;
    extraBody?: Record<string, unknown>;
    onResponse?: (json: Record<string, unknown>) => void;
  } = {},
) {
  const path = opts.path ?? "/relaySpend";
  return async (payload: ExecutorSubmitPayload): Promise<{ tx_hash: string }> => {
    // Host, write-challenge chain and proof all come from the proof's own chain. Using the
    // selected chain sent a Base proof to the Arbitrum host whenever the UI was on Arbitrum (the
    // vault-bridge Run block), failing only after the user had waited out the proof.
    const baseUrl = getTradeExecutorBaseUrl(payload.chainId);
    const headers = await getWalletWriteAuthHeaders(signer, payload.chainId);

    const extra: Record<string, unknown> = { ...(payload.extra || {}) };
    if (payload.rawPayee && !extra.rawPayee) {
      extra.rawPayee = payload.rawPayee;
    }

    // /relaySpend takes the two halves as separate fields and zero-fills the compliance one for
    // RAGEQUIT (evm_executor.py: SPEND_COMPLIANCE_WIDTH / SPEND_PROOF_WIDTH). Sending them under
    // these exact keys is what makes the relayer build a v5 `spend()` rather than reject the body.
    const body = {
      chain_id: payload.chainId,
      public_inputs: payload.publicInputs,
      proof: flattenGroth16Proof(payload.proof),
      compliancePublicInputs: payload.compliance?.publicInputs,
      complianceProof: payload.compliance?.proof,
      extra,
      ...opts.extraBody,
    };

    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errText = "";
      let parsed: Record<string, unknown> = {};
      try {
        parsed = (await res.json()) as Record<string, unknown>;
        errText = String(parsed.error || parsed.message || res.statusText);
      } catch {
        errText = await res.text();
      }
      // 402 is the relayer's prepaid withdrawal fee, not a failure of the proof. The proof is
      // valid and the withdrawal is still possible — the user can top up, or submit it themselves,
      // because spend() is permissionless. Saying "relaySpend failed (HTTP 402)" would read as
      // "your withdrawal is broken" for what is only the convenience lane being unpaid.
      if (res.status === 402 && parsed.error === "insufficient_withdraw_credit") {
        throw new WithdrawCreditRequiredError(
          String(parsed.required_wei ?? "0"),
          String(parsed.balance_wei ?? "0"),
        );
      }
      throw new Error(`executor ${path.slice(1)} failed (HTTP ${res.status}): ${errText}`);
    }

    const json = (await res.json()) as { status?: string; tx_hash?: string; txHash?: string };
    opts.onResponse?.(json);
    const tx_hash = json.tx_hash || json.txHash || "";
    if (!tx_hash) {
      throw new Error(`executor ${path.slice(1)} response missing tx_hash`);
    }
    return { tx_hash };
  };
}

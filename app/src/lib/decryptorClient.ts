/**
 * Upload the FHE client key to the confidential-vm decryptor (via trade-executor proxy).
 * Decryption of strategy inputs never happens — only the engine's encrypted result bit
 * is decrypted inside the VM.
 */

import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import {
  attestAndSealClientKey,
  invalidateAttestationCache,
  isSealedUploadEnabled,
} from "@/lib/decryptorAttestation";
import { getSigner } from "@/lib/nexus";
import { getWalletWriteAuthHeaders, getCachedWalletAuthHeaders } from "@/lib/walletAuthHeaders";
import { fingerprintClientKey } from "@/lib/fheKeyWarmup";

/** localStorage key holding the fingerprint of the ClientKey last uploaded to the decryptor. */
const uploadedFpKey = (userId: string) =>
  `siphon.decryptor.ck.${userId.startsWith("0x") ? userId.toLowerCase() : userId}`;

/** Write-challenge headers — never send API_TOKEN from the browser. */
async function writeAuthHeaders(userId: string): Promise<Record<string, string>> {
  // A Phantom (Devnet) id proves itself with its Phantom session, never an EVM signature.
  if (userId && !userId.startsWith("0x")) {
    const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
    return { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) };
  }
  const signer = getSigner();
  if (signer) return getWalletWriteAuthHeaders(signer);
  return { "Content-Type": "application/json", ...getCachedWalletAuthHeaders(userId) };
}

/** True when autonomous TEE execution is enabled (no browser decrypt loop). */
export function isTeeAutonomousMode(): boolean {
  return process.env.NEXT_PUBLIC_TEE_AUTONOMOUS === "true";
}

export async function hasClientKeyInDecryptor(userId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${getTradeExecutorBaseUrl()}/hasClientKey/${encodeURIComponent(userId)}`,
      {
        headers: userId && !userId.startsWith("0x")
          ? await (await import("@/lib/solanaWalletAuth")).getSolanaExecutorHeaders()
          : getCachedWalletAuthHeaders(userId),
      },
    );
    if (!res.ok) return false;
    const json = await res.json();
    return Boolean(json?.has_key);
  } catch {
    return false;
  }
}

/**
 * Send the client key to the confidential VM (one-time per wallet). The browser keeps a
 * local copy for encrypting bounds; the VM copy enables server-side trigger decryption.
 */
export async function ensureClientKeyInDecryptor(
  userId: string,
  clientKeyHex: string,
  onUpload?: () => void,
  force = false,
): Promise<void> {
  // No TEE-mode gate: the confidential-VM decryptor is now the ONLY execution path (the browser
  // auto-executor was removed), so the enclave must always hold the CURRENT client key.
  //
  // `force` (used at order submit) skips the fingerprint guard and re-uploads every time. The
  // guard below is unreliable across generations — the enclave reloads sealed keys from disk that
  // can be OLDER than what localStorage believes was uploaded, so it would wrongly skip and leave
  // the enclave decrypting fresh results with a stale key → garbage → mismatch. The client key is
  // small (~22KB sealed), so forcing a re-sync per order is cheap and guarantees correctness.
  if (!force) {
    const localFp = await fingerprintClientKey(clientKeyHex);
    let uploadedFp: string | null = null;
    try { uploadedFp = localStorage.getItem(uploadedFpKey(userId)); } catch { /* no storage */ }
    const already = await hasClientKeyInDecryptor(userId);
    if (already && uploadedFp === localFp) return;
  }

  onUpload?.();
  // Sealed path (NEXT_PUBLIC_DECRYPTOR_MEASUREMENT set): verify the decryptor's TDX quote,
  // then seal the key to the attested enclave pubkey — the proxy/host never see plaintext.
  // Fail closed on TWO levels:
  //   1. if attestation fails, attestAndSealClientKey throws (no plaintext fallback), and
  //   2. if sealing is not even configured, we refuse to upload rather than silently sending the
  //      raw ClientKey through the executor proxy. A plaintext upload is allowed ONLY behind an
  //      explicit local-dev escape hatch, never by simply forgetting to set the measurement.
  // One host for attest + upload: a chain switch in between would otherwise seal to one chain's
  // decryptor and deliver through the other's executor.
  const executorBase = getTradeExecutorBaseUrl();
  // Solana Devnet and TEE-autonomous builds must stay on the sealed path. Plaintext through the
  // executor proxy is a local-only escape for EVM debug.
  const solanaUser = Boolean(userId && !userId.startsWith("0x"));
  const refusePlaintext =
    solanaUser ||
    isTeeAutonomousMode() ||
    process.env.NEXT_PUBLIC_ALLOW_MOCK_TEE === "true";
  let payload: string;
  if (isSealedUploadEnabled()) {
    payload = await attestAndSealClientKey(clientKeyHex, executorBase);
  } else if (!refusePlaintext && process.env.NEXT_PUBLIC_ALLOW_PLAINTEXT_CLIENTKEY === "true") {
    payload = clientKeyHex;
  } else {
    throw new Error(
      "Refusing to upload ClientKey: sealed TEE attestation is not configured " +
        "(set NEXT_PUBLIC_DECRYPTOR_MEASUREMENT or NEXT_PUBLIC_ALLOW_MOCK_TEE=true). " +
        "Plaintext ClientKey upload is disabled for Solana / TEE-autonomous builds.",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${executorBase}/uploadClientKey`, {
      method: "POST",
      headers: await writeAuthHeaders(userId),
      body: JSON.stringify({ user_id: userId, client_key: payload }),
    });
  } catch (networkErr) {
    // Network error (e.g. 502 gateway, enclave restart) — drop cached attestation so the
    // next retry re-verifies and re-seals to whatever pubkey the (new) enclave has.
    invalidateAttestationCache();
    throw networkErr;
  }
  if (!res.ok) {
    // A rejected sealed blob usually means the enclave rebooted (new per-boot pubkey) —
    // drop the cached attestation so the retry re-verifies and re-seals to the fresh key.
    invalidateAttestationCache();
    const text = await res.text();
    throw new Error(
      text.length > 200 ? `Failed to upload client key to confidential VM (${res.status})` : text,
    );
  }
  // Record which ClientKey the enclave now holds, so the non-forced guard can skip until it changes.
  try {
    localStorage.setItem(uploadedFpKey(userId), await fingerprintClientKey(clientKeyHex));
  } catch { /* no storage */ }
}

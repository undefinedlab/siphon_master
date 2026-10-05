/**
 * Server-side ASP set reads for pipeline TEE prove (screen token, no wallet session).
 */
import {
  aspBaseUrl,
  aspProxyHeaders,
  aspSetUpstreamUrl,
} from "@/lib/aspServerUrl";
import type { ComplianceWitness, InputCompliance } from "./aspClientV3";

async function serverGet(
  endpoint: "path" | "root" | "smt-path",
  chainId: number,
  query = "",
): Promise<Record<string, unknown>> {
  const base = aspBaseUrl(chainId);
  if (!base) throw new Error(`ASP not configured for chain ${chainId}`);
  const url = `${aspSetUpstreamUrl(base, endpoint)}${query}`;
  const res = await fetch(url, {
    headers: aspProxyHeaders(base, undefined, chainId),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`asp ${endpoint}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function strArr(x: unknown): string[] {
  return Array.isArray(x) ? x.map((v) => String(v)) : [];
}
function numArr(x: unknown): number[] {
  return Array.isArray(x) ? x.map((v) => Number(v)) : [];
}

export async function loadComplianceWitnessMultiServer(
  labels: string[],
  chainId: number,
): Promise<ComplianceWitness> {
  if (!labels.length) throw new Error("loadComplianceWitnessMultiServer: labels required");
  const inputs = await Promise.all(
    labels.map(async (label): Promise<InputCompliance> => {
      const q = `?label=${encodeURIComponent(label)}&chainId=${chainId}`;
      const [admitted, smt] = await Promise.all([
        serverGet("path", chainId, q),
        serverGet("smt-path", chainId, q),
      ]);
      if (admitted.found === false) {
        throw new Error(
          `asp path: label ${label} not member — pipeline return was not admitted into solasp`,
        );
      }
      return {
        inLabel: String(label),
        admittedLeafIndex: Number(admitted.leafIndex ?? 0),
        admittedPathElements: strArr(admitted.pathElements),
        admittedPathIndices: numArr(admitted.pathIndices),
        revokedSmtPathElements: strArr(smt.pathElements),
        revokedSmtPathIndices: numArr(smt.pathIndices),
        revokedSmtLeaf: String(smt.claimedLeaf ?? "0"),
      };
    }),
  );
  const roots = await serverGet("root", chainId, `?chainId=${chainId}`);
  return {
    admittedRoot: String(roots.admittedRoot),
    revokedRoot: String(roots.revokedRoot),
    inputs,
  };
}

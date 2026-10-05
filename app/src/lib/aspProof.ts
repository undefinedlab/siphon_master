/**
 * Hard ASP dual-inclusion helpers for snarkjs witnesses.
 *
 * Circuits constrain: all input labels equal AND output label === that label
 * (association inheritance). Client must match — never invent a foreign label.
 *
 * Vault spends require aspRoot == Entrypoint.currentAspRoot(). HTTP ASP root can
 * race ahead of postman publish — always bind proofs to the on-chain root.
 */
import { Contract, JsonRpcProvider } from "ethers";
import { fetchAspPath, fetchAspRoot, type AspMerklePath } from "./aspClient";
import { getNetwork, getReadProviderRpcUrl, getSelectedChainId } from "./networks";

export const ASP_TREE_DEPTH = 32;

export type AspWitness = {
  aspRoot: string;
  /** Parallel to input notes: one ASP Merkle path per inLabel. */
  aspPathElements: string[][];
  aspPathIndices: string[][];
};

function padPath(path: AspMerklePath): { elements: string[]; indices: string[] } {
  const elements = path.pathElements.map(String);
  const indices = path.pathIndices.map((x) => String(x));
  while (elements.length < ASP_TREE_DEPTH) {
    elements.push("0");
    indices.push("0");
  }
  if (elements.length !== ASP_TREE_DEPTH || indices.length !== ASP_TREE_DEPTH) {
    throw new Error(
      `ASP path depth ${elements.length}/${indices.length} ≠ ${ASP_TREE_DEPTH}`,
    );
  }
  return { elements: elements.slice(0, ASP_TREE_DEPTH), indices: indices.slice(0, ASP_TREE_DEPTH) };
}

/** On-chain Entrypoint.currentAspRoot() — required public for Hard ASP spends. */
export async function fetchOnChainAspRoot(chainId?: number): Promise<string | null> {
  try {
    const id = chainId ?? getSelectedChainId();
    const net = getNetwork(id);
    const provider = new JsonRpcProvider(getReadProviderRpcUrl(id), id, { staticNetwork: true });
    const ep = new Contract(
      net.entrypoint,
      ["function currentAspRoot() view returns (uint256)"],
      provider,
    );
    const root = await ep.currentAspRoot();
    const s = root.toString();
    return s === "0" ? null : s;
  } catch {
    return null;
  }
}

/**
 * Fetch ASP Merkle paths for each input label. All paths must share the
 * on-chain currentAspRoot (falls back to HTTP root only if chain read fails).
 */
async function loadAspWitnessOnce(
  labels: string[],
): Promise<AspWitness | { error: string; transient?: boolean }> {
  if (labels.length === 0) return { error: "no labels for ASP witness" };

  const onChainRoot = await fetchOnChainAspRoot();
  const rootInfo = await fetchAspRoot();
  if (!rootInfo?.root && !onChainRoot) {
    // Transient: /api/asp-set/root 503s whenever the upstream fetch throws (ASP restart, blip),
    // and the chain read can fail independently. Retrying beats failing an arm on a hiccup.
    return {
      error: "ASP root unavailable — association set offline or unconfigured",
      transient: true,
    };
  }

  // Prefer on-chain root: vault rejects anything except currentAspRoot().
  let aspRoot = onChainRoot || rootInfo!.root;
  if (onChainRoot && rootInfo?.root && onChainRoot !== rootInfo.root) {
    aspRoot = onChainRoot;
  }

  const aspPathElements: string[][] = [];
  const aspPathIndices: string[][] = [];

  for (const label of labels) {
    const lab = String(label || "").trim();
    if (!lab || lab === "0") {
      return { error: "note missing Hard ASP label — cannot prove dual inclusion" };
    }
    const path = await fetchAspPath(lab);
    if (!path) {
      // Transient: the watcher screens + admits a fresh deposit's label on its next pass.
      return {
        error:
          "Label not admitted yet — wait for screening + postman admit, then retry",
        transient: true,
      };
    }
    if (path.root !== aspRoot) {
      if (onChainRoot && path.root !== onChainRoot) {
        // Transient: admitted to the set, but the postman's publish tx has not been mined yet.
        return {
          error:
            "Association set updated but not published on-chain yet — wait a moment for postman, then retry",
          transient: true,
        };
      }
      return { error: "ASP path root mismatch — refresh and retry" };
    }
    const padded = padPath(path);
    aspPathElements.push(padded.elements);
    aspPathIndices.push(padded.indices);
  }

  return { aspRoot, aspPathElements, aspPathIndices };
}

/** Total time to wait for a freshly deposited label to become provable. */
const ASP_ADMIT_WAIT_MS = Number(process.env.NEXT_PUBLIC_ASP_ADMIT_WAIT_MS || 180_000);
const ASP_ADMIT_POLL_MS = 5_000;

/**
 * Fetch ASP Merkle paths, waiting out the deposit→provable pipeline instead of hard-failing.
 *
 * A fresh deposit is not immediately provable: the watcher must see it (poll interval + reorg
 * confirmations), screen and admit the label, then the postman's publish tx must be MINED — the
 * circuit binds aspRoot and `_requireAspFreshAndNotRevoked` calls `aspRootExists()` on-chain.
 * Measured end-to-end on Sepolia: ~132s. Someone who deposits and immediately arms would otherwise
 * just see an error, so both stages are retried here rather than pushed onto the user.
 *
 * Only the two transient stages retry; a malformed label or a genuine root mismatch fails at once.
 * Safe to sit in: DetailsModal collects the arming fee AFTER proof generation, so a timeout here
 * costs the user nothing.
 */
export async function loadAspWitness(labels: string[]): Promise<AspWitness | { error: string }> {
  const deadline = Date.now() + ASP_ADMIT_WAIT_MS;
  let last: AspWitness | { error: string; transient?: boolean } = await loadAspWitnessOnce(labels);
  if (!("error" in last) || !last.transient) return last;

  const started = Date.now();
  const emit = (detail: Record<string, unknown>) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("siphon:aspWait", { detail }));
  };
  while (Date.now() < deadline) {
    const waitedMs = Date.now() - started;
    // Let the UI show progress — a silent 2-minute pause is indistinguishable from a hang.
    emit({ waitedMs, timeoutMs: ASP_ADMIT_WAIT_MS, reason: last.error, done: false });
    console.log(
      `[ASP] waiting for association-set admission… ${Math.round(waitedMs / 1000)}s/${Math.round(
        ASP_ADMIT_WAIT_MS / 1000,
      )}s`,
    );
    await new Promise((r) => setTimeout(r, ASP_ADMIT_POLL_MS));
    last = await loadAspWitnessOnce(labels);
    if (!("error" in last) || !last.transient) {
      // Always close the countdown out, success or not — a lingering "0s / 180s" line reads as
      // a hang even when the proof has already moved on.
      emit({ waitedMs: Date.now() - started, timeoutMs: ASP_ADMIT_WAIT_MS, done: true, ok: !("error" in last) });
      return last;
    }
  }
  emit({ waitedMs: Date.now() - started, timeoutMs: ASP_ADMIT_WAIT_MS, done: true, ok: false });
  return {
    error: `${last.error} (waited ${Math.round(ASP_ADMIT_WAIT_MS / 1000)}s — a new deposit needs ~2 min to be screened, admitted and published on-chain)`,
  };
}

const membershipCache = new Map<string, { hit: boolean; expires: number }>();
const MEMBERSHIP_HIT_MS = 60_000;
const MEMBERSHIP_MISS_MS = 5_000;

/** True when the association-set HTTP indexer has a Merkle path for this label. */
export async function labelInAssociationSet(label: string): Promise<boolean> {
  const lab = String(label || "").trim();
  if (!lab || lab === "0") return false;
  const now = Date.now();
  const cached = membershipCache.get(lab);
  if (cached && cached.expires > now) return cached.hit;
  const path = await fetchAspPath(lab);
  const hit = Boolean(path?.root);
  membershipCache.set(lab, { hit, expires: now + (hit ? MEMBERSHIP_HIT_MS : MEMBERSHIP_MISS_MS) });
  return hit;
}

/** Single-note ASP witness (swap / split). */
export async function loadAspWitnessOne(
  label: string,
): Promise<{ aspRoot: string; aspPathElements: string[]; aspPathIndices: string[] } | { error: string }> {
  const w = await loadAspWitness([label]);
  if ("error" in w) return w;
  return {
    aspRoot: w.aspRoot,
    aspPathElements: w.aspPathElements[0],
    aspPathIndices: w.aspPathIndices[0],
  };
}

/**
 * Sort labels ascending (field order) — required witness order for CrossLabelOutLabel circuit.
 */
export function sortLabelsCanonical(labels: string[]): string[] {
  return [...labels].map((l) => String(l || "").trim()).sort((a, b) => {
    const aa = BigInt(a);
    const bb = BigInt(b);
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    return 0;
  });
}

/**
 * Derive the output association label for a multi-note spend.
 *
 * - All inputs share one label → reuse it (legacy inheritance).
 * - Different labels → Poseidon fold chain in sorted order (matches label_derive.circom).
 *
 * Each input must still prove ∈ ASP individually; this only defines the change/output label.
 */
export async function deriveOutputLabel(inputLabels: string[]): Promise<string> {
  const sorted = sortLabelsCanonical(inputLabels);
  if (!sorted.length) throw new Error("cannot derive empty Hard ASP label");
  if (sorted.some((l) => !l || l === "0")) {
    throw new Error("cannot derive output label from empty Hard ASP label");
  }
  const allSame = sorted.every((l) => l === sorted[0]);
  if (allSame) return sorted[0];

  const { poseidon2 } = await import("./noteCrypto");
  let folded = BigInt(sorted[0]);
  for (let i = 1; i < sorted.length; i++) {
    folded = await poseidon2(folded, BigInt(sorted[i]));
  }
  return folded.toString();
}

/**
 * @deprecated use deriveOutputLabel — kept for call sites mid-migration.
 */
export async function inheritLabel(inputLabels: string[]): Promise<string> {
  return deriveOutputLabel(inputLabels);
}

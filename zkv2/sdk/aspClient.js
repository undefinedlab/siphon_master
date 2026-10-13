/**
 * ASP v2 HTTP client — dual roots + ASP/SMT paths (ComplianceHub aligned).
 *
 * Circom `revokedSmtLeaf` = actual slot leaf at smtKey(label) (EMPTY=0 or occupant).
 * aspv2 `/set/smt-path` returns that as `claimedLeaf`; `revokedSmtLeaf` on the wire
 * is leafHash(label) for forensics — do NOT feed that into Circom.
 */
"use strict";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Fail-closed ASP origin gate (F-4): Bearer must not be sent to attacker-controlled hosts.
 * - If ASP_ALLOWED_ORIGINS is set (comma-separated origins), require membership.
 * - Else allow only loopback http(s), unless ASP_ALLOW_ANY_BASE_URL=1.
 */
function assertAspBaseUrlAllowed(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl));
  } catch {
    throw new Error("aspClient: invalid aspBaseUrl");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("aspClient: aspBaseUrl must be http(s)");
  }
  const origin = parsed.origin;
  const allowAny =
    process.env.ASP_ALLOW_ANY_BASE_URL === "1" ||
    process.env.ASP_ALLOW_ANY_BASE_URL === "true";
  const allowed = (process.env.ASP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0) {
    if (!allowed.includes(origin)) {
      throw new Error(`aspClient: aspBaseUrl origin not in ASP_ALLOWED_ORIGINS (${origin})`);
    }
    return;
  }
  if (allowAny) return;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      "aspClient: aspBaseUrl must be loopback unless ASP_ALLOWED_ORIGINS or ASP_ALLOW_ANY_BASE_URL=1",
    );
  }
}

async function aspFetch(baseUrl, token, path, init = {}) {
  assertAspBaseUrlAllowed(baseUrl);
  const url = `${String(baseUrl).replace(/\/$/, "")}${path}`;
  const headers = {
    ...(init.headers || {}),
    Authorization: `Bearer ${token}`,
  };
  const res = await fetch(url, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchComplianceRoots(baseUrl, screenToken) {
  return aspFetch(baseUrl, screenToken, "/set/root");
}

async function fetchAdmittedPath(baseUrl, screenToken, label) {
  const q = encodeURIComponent(String(label));
  return aspFetch(baseUrl, screenToken, `/set/path?label=${q}`);
}

async function fetchSmtNonInclusionPath(baseUrl, screenToken, label) {
  const q = encodeURIComponent(String(label));
  return aspFetch(baseUrl, screenToken, `/set/smt-path?label=${q}`);
}

async function fetchSmtInclusionPath(baseUrl, screenToken, label) {
  const q = encodeURIComponent(String(label));
  return aspFetch(baseUrl, screenToken, `/set/smt-inclusion-path?label=${q}`);
}

async function screenDepositor(
  baseUrl,
  screenToken,
  { chainId, depositor, commitment, userSalt, vault },
) {
  // aspv2 PendingAdmit outbox seals userSalt on admit screen — not precommitment
  const body = { chainId, depositor, commitment };
  if (userSalt != null && userSalt !== "") body.userSalt = userSalt;
  if (vault) body.vault = vault;
  return aspFetch(baseUrl, screenToken, "/screen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function checkKytEntitlement(baseUrl, screenToken, wallet) {
  const q = encodeURIComponent(String(wallet));
  return aspFetch(baseUrl, screenToken, `/compliance-fee/check?wallet=${q}`);
}

async function verifyKytFee(baseUrl, screenToken, { wallet, txHash, chainId }) {
  return aspFetch(baseUrl, screenToken, "/compliance-fee/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, txHash, chainId }),
  });
}

async function requestAdmit(baseUrl, postmanToken, payload) {
  return aspFetch(baseUrl, postmanToken, "/set/admit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Map aspv2 `/set/smt-path` JSON → Circom SMT non-inclusion fields.
 * @param {{ claimedLeaf?: string, pathElements?: string[], pathIndices?: number[], revokedRoot?: string, revokedSmtLeaf?: string }} smt
 */
function smtPathToCircom(smt) {
  // Circom leaf = claimed/actual slot value (0 if empty). Never leafHash(own label).
  const claimed = smt.claimedLeaf != null ? String(smt.claimedLeaf) : "0";
  return {
    revokedRoot: smt.revokedRoot != null ? String(smt.revokedRoot) : undefined,
    revokedSmtPathElements: (smt.pathElements || []).map(String),
    revokedSmtPathIndices: (smt.pathIndices || []).map((x) => Number(x)),
    revokedSmtLeaf: claimed,
    claimedLeaf: claimed,
    /** leafHash(label) from ASP — forensic only; not a Circom signal */
    labelLeafHash: smt.revokedSmtLeaf != null ? String(smt.revokedSmtLeaf) : undefined,
  };
}

/**
 * Load compliance paths for one input label (prover helper).
 * Re-fetches roots after paths (F-12) so TOCTOU drift is visible to caller.
 */
async function loadComplianceWitness({ aspBaseUrl, screenToken, label }) {
  const [admitted, smt] = await Promise.all([
    fetchAdmittedPath(aspBaseUrl, screenToken, label),
    fetchSmtNonInclusionPath(aspBaseUrl, screenToken, label),
  ]);
  const roots = await fetchComplianceRoots(aspBaseUrl, screenToken);
  const circomSmt = smtPathToCircom(smt);
  return {
    admittedRoot: String(roots.admittedRoot),
    revokedRoot: String(roots.revokedRoot),
    admittedPathElements: (admitted.pathElements || []).map(String),
    admittedPathIndices: (admitted.pathIndices || []).map((x) => Number(x)),
    admittedLeafIndex: Number(admitted.leafIndex ?? 0),
    ...circomSmt,
    revokedRoot: String(circomSmt.revokedRoot ?? roots.revokedRoot),
  };
}

/**
 * Load compliance paths for N labels (same roots; one ASP+SMT path each).
 * Roots are re-fetched after paths (F-12).
 * @param {{ aspBaseUrl: string, screenToken: string, labels: (string|number)[] }} opts
 */
async function loadComplianceWitnessMulti({ aspBaseUrl, screenToken, labels }) {
  if (!labels || labels.length === 0) {
    throw new Error("loadComplianceWitnessMulti: labels required");
  }
  const perInput = await Promise.all(
    labels.map(async (label) => {
      const [admitted, smt] = await Promise.all([
        fetchAdmittedPath(aspBaseUrl, screenToken, label),
        fetchSmtNonInclusionPath(aspBaseUrl, screenToken, label),
      ]);
      const circomSmt = smtPathToCircom(smt);
      return {
        inLabel: String(label),
        admittedLeafIndex: Number(admitted.leafIndex ?? 0),
        admittedPathElements: (admitted.pathElements || []).map(String),
        admittedPathIndices: (admitted.pathIndices || []).map((x) => Number(x)),
        revokedSmtPathElements: circomSmt.revokedSmtPathElements,
        revokedSmtPathIndices: circomSmt.revokedSmtPathIndices,
        revokedSmtLeaf: circomSmt.revokedSmtLeaf,
      };
    }),
  );
  const roots = await fetchComplianceRoots(aspBaseUrl, screenToken);
  return {
    admittedRoot: String(roots.admittedRoot),
    revokedRoot: String(roots.revokedRoot),
    inputs: perInput,
  };
}

/**
 * Merge ASP/SMT paths into a PROTOCOL SpendWitness (mutates a shallow copy).
 * Requires compliance.inputs[i].inLabel === witness.inputs[i].inLabel (F-3).
 * @param {object} witness PROTOCOL SpendWitness JSON
 * @param {{ admittedRoot: string, revokedRoot: string, inputs: object[] }} compliance from loadComplianceWitnessMulti
 */
function applyComplianceWitness(witness, compliance) {
  if (!witness || typeof witness !== "object") {
    throw new Error("applyComplianceWitness: witness required");
  }
  if (!compliance?.inputs?.length) {
    throw new Error("applyComplianceWitness: compliance.inputs required");
  }
  const out = {
    ...witness,
    admittedRoot: String(compliance.admittedRoot),
    revokedRoot: String(compliance.revokedRoot),
    inputs: (witness.inputs || []).map((inp, i) => {
      const c = compliance.inputs[i];
      if (!c) {
        throw new Error(`applyComplianceWitness: missing compliance for input[${i}]`);
      }
      if (c.inLabel == null || String(c.inLabel) !== String(inp.inLabel)) {
        throw new Error(
          `applyComplianceWitness: label mismatch at [${i}] witness=${inp.inLabel} compliance=${c.inLabel}`,
        );
      }
      return {
        ...inp,
        admittedLeafIndex: c.admittedLeafIndex,
        admittedPathElements: c.admittedPathElements,
        admittedPathIndices: c.admittedPathIndices,
        revokedSmtPathElements: c.revokedSmtPathElements,
        revokedSmtPathIndices: c.revokedSmtPathIndices,
        revokedSmtLeaf: c.revokedSmtLeaf,
      };
    }),
  };
  return out;
}

module.exports = {
  assertAspBaseUrlAllowed,
  aspFetch,
  fetchComplianceRoots,
  fetchAdmittedPath,
  fetchSmtNonInclusionPath,
  fetchSmtInclusionPath,
  screenDepositor,
  checkKytEntitlement,
  verifyKytFee,
  requestAdmit,
  smtPathToCircom,
  loadComplianceWitness,
  loadComplianceWitnessMulti,
  applyComplianceWitness,
};

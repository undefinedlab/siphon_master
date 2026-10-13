/**
 * aspClient — Circom SMT leaf mapping + multi-input merge + allowlist.
 */
"use strict";

const {
  smtPathToCircom,
  applyComplianceWitness,
  assertAspBaseUrlAllowed,
} = require("../sdk/aspClient.js");

describe("aspClient smtPathToCircom", () => {
  test("maps claimedLeaf → Circom revokedSmtLeaf (not labelLeafHash)", () => {
    const out = smtPathToCircom({
      claimedLeaf: "0",
      revokedSmtLeaf: "999999", // leafHash(label) — forensic only
      revokedRoot: "42",
      pathElements: ["1", "2"],
      pathIndices: [0, 1],
    });
    expect(out.revokedSmtLeaf).toBe("0");
    expect(out.claimedLeaf).toBe("0");
    expect(out.labelLeafHash).toBe("999999");
    expect(out.revokedSmtPathElements).toEqual(["1", "2"]);
  });

  test("defaults empty claimedLeaf to 0", () => {
    const out = smtPathToCircom({ pathElements: [], pathIndices: [] });
    expect(out.revokedSmtLeaf).toBe("0");
  });
});

describe("aspClient applyComplianceWitness", () => {
  test("merges dual roots + paths into SpendWitness inputs", () => {
    const witness = {
      action: 0,
      inputCount: 1,
      stateRoot: "1",
      admittedRoot: "old",
      revokedRoot: "old",
      inputs: [{ inLabel: "7", inValue: "100", statePathElements: [] }],
    };
    const compliance = {
      admittedRoot: "A",
      revokedRoot: "R",
      inputs: [
        {
          inLabel: "7",
          admittedLeafIndex: 0,
          admittedPathElements: ["p"],
          admittedPathIndices: [0],
          revokedSmtPathElements: ["s"],
          revokedSmtPathIndices: [1],
          revokedSmtLeaf: "0",
        },
      ],
    };
    const out = applyComplianceWitness(witness, compliance);
    expect(out.admittedRoot).toBe("A");
    expect(out.revokedRoot).toBe("R");
    expect(out.inputs[0].revokedSmtLeaf).toBe("0");
    expect(out.inputs[0].admittedPathElements).toEqual(["p"]);
    expect(out.inputs[0].inValue).toBe("100");
  });

  test("F-3 rejects label mismatch / reordered compliance inputs", () => {
    const witness = {
      inputs: [
        { inLabel: "1", inValue: "10" },
        { inLabel: "2", inValue: "20" },
      ],
    };
    const compliance = {
      admittedRoot: "A",
      revokedRoot: "R",
      inputs: [
        { inLabel: "2", admittedLeafIndex: 0, admittedPathElements: [], admittedPathIndices: [], revokedSmtPathElements: [], revokedSmtPathIndices: [], revokedSmtLeaf: "0" },
        { inLabel: "1", admittedLeafIndex: 1, admittedPathElements: [], admittedPathIndices: [], revokedSmtPathElements: [], revokedSmtPathIndices: [], revokedSmtLeaf: "0" },
      ],
    };
    expect(() => applyComplianceWitness(witness, compliance)).toThrow(/label mismatch/);
  });
});

describe("aspClient assertAspBaseUrlAllowed (F-4)", () => {
  const prevOrigins = process.env.ASP_ALLOWED_ORIGINS;
  const prevAny = process.env.ASP_ALLOW_ANY_BASE_URL;

  afterEach(() => {
    if (prevOrigins === undefined) delete process.env.ASP_ALLOWED_ORIGINS;
    else process.env.ASP_ALLOWED_ORIGINS = prevOrigins;
    if (prevAny === undefined) delete process.env.ASP_ALLOW_ANY_BASE_URL;
    else process.env.ASP_ALLOW_ANY_BASE_URL = prevAny;
  });

  test("rejects non-loopback when no allowlist", () => {
    delete process.env.ASP_ALLOWED_ORIGINS;
    delete process.env.ASP_ALLOW_ANY_BASE_URL;
    expect(() => assertAspBaseUrlAllowed("https://evil.example/asp")).toThrow(
      /loopback|ASP_ALLOWED_ORIGINS/,
    );
  });

  test("allows loopback by default", () => {
    delete process.env.ASP_ALLOWED_ORIGINS;
    delete process.env.ASP_ALLOW_ANY_BASE_URL;
    expect(() => assertAspBaseUrlAllowed("http://127.0.0.1:5056")).not.toThrow();
  });

  test("enforces ASP_ALLOWED_ORIGINS", () => {
    process.env.ASP_ALLOWED_ORIGINS = "https://asp.example.com";
    delete process.env.ASP_ALLOW_ANY_BASE_URL;
    expect(() => assertAspBaseUrlAllowed("https://asp.example.com")).not.toThrow();
    expect(() => assertAspBaseUrlAllowed("http://127.0.0.1:5056")).toThrow(
      /ASP_ALLOWED_ORIGINS/,
    );
  });
});

describe("aspClient screenDepositor body (aspv2 align)", () => {
  test("sends userSalt not precommitment", async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ decision: "admit" }),
      };
    };
    try {
      const { screenDepositor } = require("../sdk/aspClient.js");
      await screenDepositor("http://127.0.0.1:5056", "tok", {
        chainId: 8453,
        depositor: "0x" + "11".repeat(20),
        commitment: "123",
        userSalt: "999",
        vault: "0x" + "aa".repeat(20),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/screen");
      expect(calls[0].body.userSalt).toBe("999");
      expect(calls[0].body.vault).toBe("0x" + "aa".repeat(20));
      expect(calls[0].body.precommitment).toBeUndefined();
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe("aspClient KYT fee helpers", () => {
  test("checkKytEntitlement hits compliance-fee/check", async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ paid: true }) };
    };
    try {
      const { checkKytEntitlement } = require("../sdk/aspClient.js");
      await checkKytEntitlement("http://127.0.0.1:5056", "tok", "0xabc");
      expect(calls[0]).toContain("/compliance-fee/check?wallet=0xabc");
    } finally {
      global.fetch = origFetch;
    }
  });

  test("verifyKytFee posts compliance-fee/verify", async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    };
    try {
      const { verifyKytFee } = require("../sdk/aspClient.js");
      await verifyKytFee("http://127.0.0.1:5056", "tok", {
        wallet: "0x1",
        txHash: "0x" + "ab".repeat(32),
        chainId: 1,
      });
      expect(calls[0].url).toContain("/compliance-fee/verify");
      expect(calls[0].body.chainId).toBe(1);
    } finally {
      global.fetch = origFetch;
    }
  });
});

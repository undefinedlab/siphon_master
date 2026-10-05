// v5 SDK checks.  bun test src/v5
// Real Groth16 proofs: npx tsx src/v5/prove.check.ts (Node — snarkjs's workers hang under bun).
//
// The vector is siphon-zk-v2 ceremony/v5-compliance-split test-vectors/withdraw-w3-ok.json
// (bf556e8): a 3-note withdraw with change, whose publics the circuit team derived from spend-core.
import { describe, expect, test } from "bun:test";
import { Interface } from "ethers";
import * as app from "../../../../src/lib/v3/noteCryptoV3";
import { planWithdraw as appPlan } from "../../../../src/lib/v3/planWithdrawV3";
import { deriveWithdrawPublics as appPublics } from "../../../../src/lib/v3/withdrawPublicsV3";
import { CHAINS } from "./constants";
import { depositTransactions, finalizeDeposit, prepareDeposit, VAULT_KERNEL_ABI } from "./deposit";
import { compliancePublics, labelCommit } from "./labelCommit";
import * as sdk from "./noteCrypto";
import { planWithdraw } from "./planWithdraw";
import { Prover } from "./prover";
import { prepareWithdrawal } from "./withdraw";
import { deriveWithdrawPublics } from "./withdrawPublics";
import { vec, vectorWorld } from "./testVector";

describe("withdraw witness matches the circuit team's vector", () => {
  test("25 spend publics, state paths and 5 compliance publics", async () => {
    const { built } = await vectorWorld();
    expect(built.expectedPublics).toEqual(vec.expectedPublic);
    // State paths rebuilt from the leaf list must be the vector's (this is what the circuit checks).
    expect(built.input.statePathElements).toEqual(vec.inputs.map((i) => i.statePathElements));
    const commit = await labelCommit(vec.inputCount, vec.inputs.map((i) => BigInt(i.inLabel)), BigInt(vec.labelSalt));
    expect(compliancePublics(vec.inputCount, BigInt(vec.admittedRoot), BigInt(vec.revokedRoot), commit)).toEqual(vec.expectedCompliancePublic);
    expect(built.expectedPublics[24]).toBe(vec.expectedCompliancePublic[3]); // the labelCommit binding
  });
});

describe("SDK copies agree with the dapp (drift guard)", () => {
  test("hashing, labels, planning and publics", async () => {
    const r = () => sdk.randomUserSalt();
    for (let k = 0; k < 5; k++) {
      const [v, l, a, n, s] = [BigInt(k * 1000 + 7), r(), BigInt("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"), r(), r()];
      expect(await sdk.hashCommitment(v, l, a, n, s)).toBe(await app.hashCommitment(v, l, a, n, s));
      const lp = { chainId: 42161, vaultAddress: CHAINS[42161].vaultKernel, depositNonce: k, userSalt: s };
      expect(await sdk.deriveDepositLabel(lp)).toBe(await app.deriveDepositLabel(lp));
    }
    const notes = [5n, 9n, 2n, 14n].map((value, i) => ({ commitment: String(i), value, label: String(100 + i), assetId: "7", nullifier: "1", secret: "2" }));
    for (const target of [2n, 7n, 13n, 30n]) expect(planWithdraw(notes, target, "7")).toEqual(appPlan(notes, target, "7"));
    const params = {
      inputs: vec.inputs.map((i) => ({ inValue: BigInt(i.inValue), inNullifier: BigInt(i.inNullifier), inSecret: BigInt(i.inSecret), inLabel: BigInt(i.inLabel), inAssetId: BigInt(i.inAssetId) })),
      boundaryIndex: vec.boundaryIndex, primaryValue: BigInt(vec.primaryValue), secondaryValue: BigInt(vec.secondaryValue),
      stateRoot: BigInt(vec.stateRoot), admittedRoot: BigInt(vec.admittedRoot), revokedRoot: BigInt(vec.revokedRoot),
      outNullifier: 1n, outSecret: 2n, rawPayee: "0x00000000000000000000000000000000000000b2", chainId: 42161, labelCommitSalt: 12345n,
    };
    expect(await deriveWithdrawPublics(params)).toEqual(await appPublics(params));
  });
});

describe("deposit", () => {
  test("ETH: one payable tx; the note holds WETH", async () => {
    const d = await prepareDeposit({ chainId: 42161, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amount: 10n ** 13n });
    const txs = depositTransactions(d);
    expect(txs).toHaveLength(1);
    expect(txs[0].to).toBe(CHAINS[42161].vaultKernel);
    expect(txs[0].value).toBe("10000000000000");
    expect(d.noteToken).toBe(CHAINS[42161].weth);
  });

  test("USDC approves the pinned asset adapter, not the kernel (S-16)", async () => {
    const d = await prepareDeposit({ chainId: 8453, token: CHAINS[8453].usdc, amount: 500000n });
    const [approve, dep] = depositTransactions(d);
    expect(approve.to).toBe(CHAINS[8453].usdc);
    expect(approve.data.toLowerCase()).toContain(CHAINS[8453].assetAdapter.slice(2).toLowerCase());
    expect(dep.to).toBe(CHAINS[8453].vaultKernel);
    // PoC: an integrator fed an attacker's "adapter" must not approve it.
    expect(() => depositTransactions(d, { assetAdapter: "0x00000000000000000000000000000000000000aa" })).toThrow(/not Base's asset adapter/);
  });

  test("receipt → note, and a mismatched receipt is refused", async () => {
    const d = await prepareDeposit({ chainId: 42161, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amount: 10n ** 13n });
    const nonce = 41n;
    const label = await sdk.deriveDepositLabel({ chainId: 42161, vaultAddress: CHAINS[42161].vaultKernel, depositNonce: nonce, userSalt: BigInt(d.userSalt) });
    const commitment = await sdk.hashCommitment(10n ** 13n, label, BigInt(CHAINS[42161].weth), BigInt(d.nullifier), BigInt(d.secret));
    const iface = new Interface(VAULT_KERNEL_ABI);
    const log = (c: bigint) => ({ address: CHAINS[42161].vaultKernel, ...iface.encodeEventLog("Deposited", ["0x00000000000000000000000000000000000000cc", CHAINS[42161].weth, 10n ** 13n, c, nonce, 1n]) });
    const note = await finalizeDeposit(d, { logs: [log(commitment)] });
    expect(note.commitment).toBe(commitment.toString());
    expect(note.label).toBe(label.toString());
    expect(note.depositNonce).toBe("41");
    await expect(finalizeDeposit(d, { logs: [log(commitment + 1n)] })).rejects.toThrow(/do not match/);
    await expect(finalizeDeposit(d, { logs: [] })).rejects.toThrow(/no Deposited/);
  });
});

describe("API client signs exactly what the gateway verifies", () => {
  test("intent message golden (api-gateway canonical_intent_message)", async () => {
    const { intentMessage } = await import("./api");
    // Nested keys out of order + non-ASCII: the two places a naive encoder diverges from Python.
    const body = { note: "né", amount_minor: 500000, asset: "USDC", spend: { extra: { rawPayee: "0xAb" }, public_inputs: ["0", "1"] }, chain_id: 42161 };
    expect(await intentMessage({ chainId: 42161, timestamp: "1700000000", nonce: "n-1", method: "post", path: "/v1/payouts", body })).toBe(
      "Siphon API v2\nchain_id:42161\ntimestamp:1700000000\nnonce:n-1\nmethod:POST\npath:/v1/payouts\nbody_sha256:27b7348768d2acef1fe711f9758688011206968f82d2d37c919b2df3ac506625",
    );
  });

  test("payout sends the bundle without chain_id and the relayer challenge headers", async () => {
    const { SiphonApi } = await import("./api");
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = String(url).includes("wallet-challenges") ? { nonce: NONCE, message: `Siphon auth v2:write:42161:${NONCE}` } : { operation: {}, submission_mode: "relay", transaction: null, tx_hash: "0x1" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const wallet = { getAddress: async () => "0x1111111111111111111111111111111111111111", signMessage: async (m: string) => `sig(${m.split("\n")[0]})` };
    const api = new SiphonApi({ apiKey: "sk_live_x", wallet, baseUrl: "https://gw.test", fetch: fake });
    const spend = bundle();
    await api.payout({ chainId: 42161, accountId: "acc", asset: "USDC", recipient: PAYEE, amountMinor: 5n, spend, idempotencyKey: "k" });
    expect(calls[0].url).toBe("https://gw.test/v1/wallet-challenges?chain_id=42161");
    const h = calls[1].init.headers as Record<string, string>;
    expect(h["X-Write-Nonce"]).toBe(NONCE);
    expect(h["X-Write-Signature"]).toBe(`sig(Siphon auth v2:write:42161:${NONCE})`);
    expect(h["X-Signature"]).toBe("sig(Siphon API v2)");
    expect(h.Authorization).toBe("Bearer sk_live_x");
    expect(JSON.parse(String(calls[1].init.body)).spend.chain_id).toBeUndefined();
  });
});

// ── DELTA: one regression per OMEGA finding (2026-09-29), using each finding's PoC ──────────────

const PAYEE = "0x2222222222222222222222222222222222222222";
const NONCE = "ab".repeat(16);
const WALLET = { getAddress: async () => "0x1111111111111111111111111111111111111111", signMessage: async (m: string) => `sig(${m.split("\n")[0]})` };

function bundle(over: Partial<{ amount: bigint; payee: string; token: string }> = {}) {
  const pub = new Array(25).fill("0");
  pub[5] = String(over.amount ?? 5n);
  pub[16] = "5";
  pub[17] = BigInt(over.token ?? CHAINS[42161].usdc).toString();
  return { chain_id: 42161, public_inputs: pub, proof: new Array(8).fill("1"), compliancePublicInputs: ["1", "2", "3", "4", "5"], complianceProof: new Array(8).fill("2"), extra: { rawPayee: over.payee ?? PAYEE } };
}

function apiReturning(reply: (url: string) => unknown, sink: string[] = []) {
  const { SiphonApi } = require("./api");
  const fake = (async (url: URL) => {
    sink.push(String(url));
    return new Response(JSON.stringify(reply(String(url))), { status: 200 });
  }) as unknown as typeof fetch;
  return new SiphonApi({ apiKey: "k", wallet: WALLET, baseUrl: "https://gw.test", fetch: fake });
}

describe("OVERLORD S-1: API deposit calldata is never trusted", () => {
  test("an attacker precommitment in the returned deposit tx is refused", async () => {
    const d = await prepareDeposit({ chainId: 42161, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amount: 10n ** 13n });
    const evil = depositTransactions({ ...d, precommitment: "666" })[0];
    const api = apiReturning(() => ({ operation: null, phase: "deposit", commitment: "1", transactions: [{ ...evil, chain_id: 42161, purpose: "deposit" }] }));
    await expect(api.deposit("acc", d, { asset: "ETH", idempotencyKey: "i" })).rejects.toThrow(/differ from the locally built/);
  });
  test("an approve to the attacker's spender is refused; the honest reply passes", async () => {
    const d = await prepareDeposit({ chainId: 42161, token: CHAINS[42161].usdc, amount: 1000n });
    const honest = depositTransactions(d)[0];
    const evil = { ...honest, data: honest.data.replace(CHAINS[42161].assetAdapter.slice(2).toLowerCase(), "a".repeat(40)) };
    expect(evil.data).not.toBe(honest.data);
    await expect(apiReturning(() => ({ phase: "approve", transactions: [{ ...evil, chain_id: 42161, purpose: "approve_deposit" }] })).deposit("acc", d, { asset: "USDC", idempotencyKey: "i" })).rejects.toThrow(/differ/);
    const ok = await apiReturning(() => ({ phase: "approve", transactions: [{ ...honest, chain_id: 42161, purpose: "approve_deposit" }] })).deposit("acc", d, { asset: "USDC", idempotencyKey: "i" });
    expect(ok.transactions[0].data).toBe(honest.data);
  });
  test("the asset argument must match the prepared deposit", async () => {
    const d = await prepareDeposit({ chainId: 42161, token: CHAINS[42161].usdc, amount: 1000n });
    await expect(apiReturning(() => ({})).deposit("acc", d, { asset: "ETH", idempotencyKey: "i" })).rejects.toThrow(/does not match/);
  });
});

describe("OVERLORD S-2 / S-10: proving artifacts are pinned", () => {
  const vkeyPath = "ceremony/withdraw1/verification_key.json";
  test("a tampered artifact from any source is refused, an unpinned path is refused", async () => {
    const fs = await import("node:fs/promises");
    const real = new Uint8Array(await fs.readFile(new URL("../../../../public/zk/ceremony/withdraw1/verification_key.json", import.meta.url)));
    const load = (p: Prover) => (p as unknown as { load(x: string): Promise<Uint8Array> }).load.bind(p);
    expect(await load(new Prover({ load: async () => real }))(vkeyPath)).toEqual(real);
    const evil = new Uint8Array(real); evil[10] ^= 1; // PoC: a one-byte swap from a hostile origin
    await expect(load(new Prover({ load: async () => evil }))(vkeyPath)).rejects.toThrow(/refusing to prove/);
    await expect(load(new Prover({ load: async () => real }))("withdraw1/main_evil.wasm")).rejects.toThrow(/no release pin/);
  });
  test("a poisoned cache entry is ignored and replaced with verified bytes", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const real = new Uint8Array(await fs.readFile(new URL("../../../../public/zk/ceremony/withdraw1/verification_key.json", import.meta.url)));
    const dir = await fs.mkdtemp(`${os.tmpdir()}/siphon-pin-`);
    const pin = (await import("./zkPins")).ZK_PINS[vkeyPath];
    await fs.writeFile(`${dir}/${pin}`, "poisoned");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(real)) as unknown as typeof fetch;
    try {
      const p = new Prover({ cacheDir: dir });
      expect(await (p as unknown as { load(x: string): Promise<Uint8Array> }).load(vkeyPath)).toEqual(real);
      expect(new Uint8Array(await fs.readFile(`${dir}/${pin}`))).toEqual(real);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("OVERLORD S-3: only the relayer's own challenge is signed", () => {
  test("a SIWE message dressed as a challenge is refused and never signed", async () => {
    const signed: string[] = [];
    const wallet = { ...WALLET, signMessage: async (m: string) => (signed.push(m), "sig") };
    const { SiphonApi } = await import("./api");
    const fake = (async (url: URL) => new Response(JSON.stringify(String(url).includes("challenges")
      ? { nonce: NONCE, message: "evil.com wants you to sign in with your Ethereum account" } : {}), { status: 200 })) as unknown as typeof fetch;
    const api = new SiphonApi({ apiKey: "k", wallet, baseUrl: "https://gw.test", fetch: fake });
    await expect(api.payout({ chainId: 42161, accountId: "a", asset: "USDC", recipient: PAYEE, amountMinor: 5n, spend: bundle(), idempotencyKey: "i" })).rejects.toThrow(/refusing to sign/);
    expect(signed.some((m) => m.includes("evil.com"))).toBe(false);
  });
});

describe("OVERLORD S-4: unsigned payout is encoded locally", () => {
  test("an API-supplied transfer instead of VaultKernel.spend is refused", async () => {
    const api = apiReturning(() => ({ operation: {}, submission_mode: "unsigned", transaction: { to: CHAINS[42161].usdc, data: "0xa9059cbb", value: "0" }, tx_hash: null }));
    await expect(api.payout({ chainId: 42161, accountId: "a", asset: "USDC", recipient: PAYEE, amountMinor: 5n, spend: bundle(), idempotencyKey: "i", mode: "unsigned" })).rejects.toThrow(/differs from the locally built/);
    const { spendTransaction } = await import("./deposit");
    const good = spendTransaction(bundle());
    const ok = await apiReturning(() => ({ operation: {}, submission_mode: "unsigned", transaction: { ...good, chain_id: 42161, purpose: "payout" }, tx_hash: null }))
      .payout({ chainId: 42161, accountId: "a", asset: "USDC", recipient: PAYEE, amountMinor: 5n, spend: bundle(), idempotencyKey: "i", mode: "unsigned" });
    expect(ok.transaction.to).toBe(CHAINS[42161].vaultKernel);
  });
});

describe("OVERLORD S-5: wei amounts above 2^53 are exact", () => {
  test("0.01 ETH signs and sends the exact integer the gateway hashes", async () => {
    const { canonicalJson, intentMessage } = await import("./api");
    const body = { chain_id: 42161, asset: "ETH", amount_minor: 10n ** 16n, precommitment: "7", user_salt: "9" };
    expect(canonicalJson(body)).toContain('"amount_minor":10000000000000000');
    expect(await intentMessage({ chainId: 42161, timestamp: "1700000000", nonce: "n-2", method: "POST", path: "/v1/accounts/a/deposits", body }))
      .toBe("Siphon API v2\nchain_id:42161\ntimestamp:1700000000\nnonce:n-2\nmethod:POST\npath:/v1/accounts/a/deposits\nbody_sha256:fd45dcd93080e518d2b97beea229806cbc5186f1b09dddc66ad4c24ad698b069");
  });
});

describe("OVERLORD S-6: Sepolia is the v5 stack, admin-only", () => {
  test("kernel and hub are the 2026-09-05 v5 deployment", () => {
    expect(CHAINS[11155111].vaultKernel).toBe("0x586dFaa329D71de7368617C9f00395C040bCf84a");
    expect(CHAINS[11155111].complianceHub).toBe("0x8Dc981a93B0cfffFC4a368F4010f7581E7806D62");
    expect(CHAINS[11155111].adminOnly).toBe(true);
    expect(CHAINS[8453].adminOnly || CHAINS[42161].adminOnly).toBe(false);
  });
});

describe("OVERLORD S-7: batched receipts", () => {
  test("our Deposited log is found even when another deposit comes first", async () => {
    const d = await prepareDeposit({ chainId: 42161, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amount: 10n ** 13n });
    const nonce = 7n;
    const label = await sdk.deriveDepositLabel({ chainId: 42161, vaultAddress: CHAINS[42161].vaultKernel, depositNonce: nonce, userSalt: BigInt(d.userSalt) });
    const commitment = await sdk.hashCommitment(10n ** 13n, label, BigInt(CHAINS[42161].weth), BigInt(d.nullifier), BigInt(d.secret));
    const iface = new Interface(VAULT_KERNEL_ABI);
    const log = (c: bigint, n: bigint) => ({ address: CHAINS[42161].vaultKernel, ...iface.encodeEventLog("Deposited", ["0x00000000000000000000000000000000000000cc", CHAINS[42161].weth, 10n ** 13n, c, n, 1n]) });
    const note = await finalizeDeposit(d, { logs: [log(123n, 6n), log(commitment, nonce)] });
    expect(note.commitment).toBe(commitment.toString());
  });
});

describe("OVERLORD S-8: the payout request is bound to the proof before signing", () => {
  for (const [name, args] of [
    ["recipient", { recipient: "0x3333333333333333333333333333333333333333" }],
    ["amount", { amountMinor: 6n }],
    ["asset", { asset: "WETH" }],
  ] as const) {
    test(`mismatched ${name} is refused with no request sent`, async () => {
      const sent: string[] = [];
      const api = apiReturning(() => ({}), sent);
      await expect(api.payout({ chainId: 42161, accountId: "a", asset: "USDC", recipient: PAYEE, amountMinor: 5n, spend: bundle(), idempotencyKey: "i", ...args })).rejects.toThrow(/differs from the proof/);
      expect(sent).toEqual([]);
    });
  }
});

describe("OVERLORD S-9 / S-11: withdrawal input checks", () => {
  const data = { stateLeaves: async () => [1n, 2n], complianceWitness: async () => { throw new Error("must not reach ASP"); } };
  const note = { chainId: 42161, token: CHAINS[42161].weth, assetId: BigInt(CHAINS[42161].weth).toString(), value: "100", label: "5", nullifier: "1", secret: "2", commitment: "9" };
  test("forged leaves that do not rebuild the kernel's root stop before proving", async () => {
    const provider = { call: async () => "0x" + "11".repeat(32) } as never;
    await expect(prepareWithdrawal({ chainId: 42161, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amount: 50n, recipient: PAYEE, notes: [note], data, provider })).rejects.toThrow(/on-chain root/);
  });
  test("a one-character typo in a checksummed recipient is refused", async () => {
    const typo = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"; // EIP-55 example 0x5aAe…BeAed with the last char case flipped
    await expect(prepareWithdrawal({ chainId: 42161, token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", amount: 50n, recipient: typo, notes: [note], data })).rejects.toThrow(/EIP-55/);
  });
});

describe("OVERLORD S-12 / S-13: hostile paging and path input", () => {
  test("a server claiming 1e12 leaves, or stalling, is refused", async () => {
    await expect(apiReturning(() => ({ total_count: 1e12, leaves: ["1"] })).stateLeaves(42161)).rejects.toThrow(/implausible/);
    await expect(apiReturning(() => ({ total_count: 10, leaves: [] })).stateLeaves(42161)).rejects.toThrow(/stopped before/);
  });
  test("a traversal label never reaches the network", async () => {
    const sent: string[] = [];
    await expect(apiReturning(() => ({}), sent).labelStatus(42161, "../../v1/accounts")).rejects.toThrow(/invalid label/);
    expect(sent).toEqual([]);
  });
});

describe("OVERLORD S-14: salts", () => {
  test("never fail, stay in the field, never zero", () => {
    for (let i = 0; i < 5000; i++) {
      const v = sdk.randomUserSalt();
      expect(v > 0n && v < sdk.FIELD).toBe(true);
    }
  });
});

describe("OVERLORD G-8: relayer challenges are chain-bound", () => {
  test("a Base-bound challenge handed out for an Arbitrum payout is refused and never signed", async () => {
    const signed: string[] = [];
    const wallet = { ...WALLET, signMessage: async (m: string) => (signed.push(m), "sig") };
    const { SiphonApi } = await import("./api");
    const fake = (async (url: URL) => new Response(JSON.stringify(String(url).includes("challenges")
      ? { nonce: NONCE, message: `Siphon auth v2:write:8453:${NONCE}` } : {}), { status: 200 })) as unknown as typeof fetch;
    const api = new SiphonApi({ apiKey: "k", wallet, baseUrl: "https://gw.test", fetch: fake });
    await expect(api.payout({ chainId: 42161, accountId: "a", asset: "USDC", recipient: PAYEE, amountMinor: 5n, spend: bundle(), idempotencyKey: "i" })).rejects.toThrow(/refusing to sign/);
    expect(signed.some((m) => m.includes("write:"))).toBe(false);
  });
  test("the old unbound v1 message is refused too", async () => {
    const api = apiReturning((u) => (u.includes("challenges") ? { nonce: NONCE, message: `Siphon auth v1:write:${NONCE}` } : {}));
    await expect(api.payout({ chainId: 42161, accountId: "a", asset: "USDC", recipient: PAYEE, amountMinor: 5n, spend: bundle(), idempotencyKey: "i" })).rejects.toThrow(/refusing to sign/);
  });
});

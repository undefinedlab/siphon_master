/**
 * Strategy payouts: a builder "Withdraw to <chain>" becomes an enclave-armed WITHDRAW to the
 * executor, which bridges the fired order there. These pin the pieces that decide WHERE money goes.
 */
import { expect, mock, test } from "bun:test";

// Sealing needs the enclave's attested key; the payload is what is under test, so seal = identity.
mock.module("../v3/sealLegSecretsV3", () => ({
  sealLegSecrets: async (s: unknown) => JSON.stringify(s),
}));

const SOL = "8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg";
const ZEC_T1 = "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU";
const PAYEE = "0x5830A431E6866B8F8a605625b0713D8190FB06bA";

test("only the Base hub pays out, and only to a listed destination", async () => {
  const { payoutDestFor, SOLANA_LIFI_ID } = await import("../bridge/hub");
  expect(payoutDestFor(8453, "Solana")?.id).toBe(SOLANA_LIFI_ID);
  expect(payoutDestFor(8453, "Base")).toBeNull();      // home: keep private
  expect(payoutDestFor(8453, "Bitcoin")).toBeNull();   // no route
  expect(payoutDestFor(42161, "Solana")).toBeNull();   // not the hub
});

test("a payout delivers USDC, ZEC on Zcash, and ETH only where LI.FI has native ETH", async () => {
  const { bridgeDest, payoutToken, SOLANA_LIFI_ID, SOLANA_USDC_MINT, ZCASH_LIFI_ID } = await import("../bridge/hub");
  expect(payoutToken(bridgeDest(SOLANA_LIFI_ID)!, "USDC")).toBe(SOLANA_USDC_MINT);
  expect(payoutToken(bridgeDest(SOLANA_LIFI_ID)!, "ETH")).toBeNull();
  expect(payoutToken(bridgeDest(42161)!, "ETH")).toBe("ETH");
  expect(payoutToken(bridgeDest(1337)!, "ETH")).toBeNull();
  expect(payoutToken(bridgeDest(ZCASH_LIFI_ID)!, "ETH")).toBe("ZEC");
});

test("a pasted Solana or Zcash address decides the destination, whatever the model said", async () => {
  const { addressOnlyChain, mergeLlmOntoParsed } = await import("../../builder_agent/mergeLlmParsed");
  const { createDefaultParsed } = await import("../../builder_agent/parsedDefaults");
  expect(addressOnlyChain(SOL)).toBe("Solana");
  expect(addressOnlyChain(ZEC_T1)).toBe("Zcash");
  expect(addressOnlyChain(PAYEE)).toBeNull();

  const base = createDefaultParsed("x", { withdrawChain: "Base" });
  expect(mergeLlmOntoParsed(base, { wallet: SOL, withdrawChain: "Arbitrum" }, "x").withdrawChain).toBe("Solana");
  expect(mergeLlmOntoParsed(base, { withdrawChain: "hyperliquid" }, "x").withdrawChain).toBe("Hyperliquid");
  expect(mergeLlmOntoParsed(base, { withdrawChain: "Bitcoin" }, "x").withdrawChain).toBe("Base");
});

test("a payout leg is armed as a WITHDRAW of the whole note to the payee", async () => {
  const { buildArmedLeg } = await import("../v3/armLegV3");
  const { payeeIdEvm } = await import("../v3/payeeV3");
  const note = { value: 10n ** 15n, nullifier: 11n, secret: 12n, label: 13n, assetId: 0x4200n, commitment: 99n };
  const common = {
    chainId: 8453, strategyId: "s", legIndex: 0, note, stateLeaves: [99n],
    swap: { amountIn: note.value, change: 0n, pool: 1n, dstToken: 2n, fee: 500n, minAmountOut: 3n, outputPrecommitment: 4n },
    outNullifier: 21n, outSecret: 22n, destNullifier: 23n, destSecret: 24n, admittedRoot: 5n, revokedRoot: 6n,
  };

  const leg = await buildArmedLeg({ ...common, payee: PAYEE });
  const pi = leg.public.expectedPublic as string[];
  expect(JSON.parse(leg.sealedSecrets).action).toBe(0);
  expect(pi[0]).toBe("0");                                   // WITHDRAW
  expect(pi[5]).toBe(note.value.toString());                 // the whole note
  expect(pi[6]).toBe("0");                                   // no change
  expect(pi[15]).toBe((await payeeIdEvm(PAYEE)).toString()); // bound to the payee
  expect(pi[17]).toBe(note.assetId.toString());
  expect(leg.public.rawPayeeHex).toBe(PAYEE.slice(2).toLowerCase());

  // Without a payee it is still the swap leg it always was.
  const swap = await buildArmedLeg(common);
  expect(JSON.parse(swap.sealedSecrets).action).toBe(2);
  expect(swap.public.rawPayeeHex).toBe("00".repeat(20));
});

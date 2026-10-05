// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { hashCommitment } from "../noteCrypto";

/**
 * Entrypoint.swapAndDeposit re-shields its output via ChangeLabeled + LeafInserted and emits NO
 * Deposited event, so resolveOutputNote's indexer lookup and Deposited scan both come back empty
 * and the swapped balance never appears in the UI. The recovery path instead reads the amount out
 * of the vault's inflow and proves the pairing against the on-chain commitment.
 *
 * These values are a REAL Base swapAndDeposit — strategy 81444cdc, tx 0x05827a30…, leaf index 0 of
 * the Base USDC vault. Pinning them means a change to the commitment scheme, the Poseidon
 * parameters, or the field order fails here rather than silently stranding a user's balance.
 */
const LABEL = 2614138311925871314634849636377833113033596093865213788776996825529743584664n;
const PRECOMMITMENT = 19743632066793483397354767356063998668527737815045181921249489933692315628026n;
const ON_CHAIN_LEAF = 4153155069710105251353549333256795631248133372879859641848133466632620226190n;
const VAULT_INFLOW = 233938n; // 0.233938 USDC, the pool's Transfer into the vault

describe("re-shielded swap output recovery", () => {
  test("the vault inflow reproduces the on-chain commitment", async () => {
    expect(await hashCommitment(VAULT_INFLOW, LABEL, PRECOMMITMENT)).toBe(ON_CHAIN_LEAF);
  });

  test("a wrong amount is rejected, so reading it from a Transfer log stays safe", async () => {
    // This is the whole reason the candidate amounts can come from an untrusted-ish source: every
    // candidate is checked against the commitment, so only the true one can ever be accepted.
    for (const wrong of [VAULT_INFLOW - 1n, VAULT_INFLOW + 1n, 0n, 100000000n]) {
      expect(await hashCommitment(wrong, LABEL, PRECOMMITMENT)).not.toBe(ON_CHAIN_LEAF);
    }
  });

  test("a different note's precommitment does not match this leaf", async () => {
    // The stale pending record the UI was polling for. It must not resolve against someone
    // else's — or an earlier attempt's — leaf.
    const stale = 9206353327063409050265008285360427385015917381850245506329760829061269133367n;
    expect(await hashCommitment(VAULT_INFLOW, LABEL, stale)).not.toBe(ON_CHAIN_LEAF);
  });
});

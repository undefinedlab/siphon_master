/**
 * Delegation verification tests.
 *
 * verifyDelegation decides whether a session key may act for a wallet. Every accept it gets wrong
 * is an impersonation, so the cases below are mostly attacks rather than happy paths.
 */
import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";

import {
  SESSION_MAX_AGE_SEC,
  buildDelegationMessage,
  verifyDelegation,
} from "../sessionKey";

const NOW = 1_800_000_000;
const DOMAIN = "siphon.money";

async function makeDelegation(over: Partial<Record<string, unknown>> = {}) {
  const walletKey = Wallet.createRandom();
  const sessionKey = Wallet.createRandom();
  const unsigned = {
    sessionAddress: sessionKey.address,
    wallet: walletKey.address.toLowerCase(),
    chainId: 8453,
    domain: DOMAIN,
    issuedAt: NOW,
    expiresAt: NOW + SESSION_MAX_AGE_SEC,
    nonce: "test-nonce",
    ...over,
  };
  const signature = await walletKey.signMessage(buildDelegationMessage(unsigned as never));
  return { walletKey, sessionKey, blob: JSON.stringify({ ...unsigned, signature }) };
}

describe("verifyDelegation", () => {
  test("accepts a well-formed delegation and returns the authorizing wallet", async () => {
    const { walletKey, sessionKey, blob } = await makeDelegation();
    const res = verifyDelegation(blob, { nowSec: NOW + 60, expectedDomain: DOMAIN });
    expect(res).not.toBeNull();
    expect(res!.wallet).toBe(walletKey.address.toLowerCase());
    expect(res!.sessionAddress).toBe(sessionKey.address);
  });

  test("rejects an expired delegation", async () => {
    const { blob } = await makeDelegation();
    const past = NOW + SESSION_MAX_AGE_SEC + 1;
    expect(verifyDelegation(blob, { nowSec: past, expectedDomain: DOMAIN })).toBeNull();
  });

  test("rejects a delegation issued in the future beyond skew tolerance", async () => {
    const { blob } = await makeDelegation({ issuedAt: NOW + 600 });
    expect(verifyDelegation(blob, { nowSec: NOW, expectedDomain: DOMAIN })).toBeNull();
  });

  test("rejects a self-extended lifetime even though the signature is valid", async () => {
    // The wallet really did sign this — the defence is the max-age rule, not the signature.
    // Without it a client could mint a ten-year delegation and every crypto check would pass.
    const { blob } = await makeDelegation({
      expiresAt: NOW + SESSION_MAX_AGE_SEC * 365,
    });
    expect(verifyDelegation(blob, { nowSec: NOW + 60, expectedDomain: DOMAIN })).toBeNull();
  });

  test("rejects a delegation signed for a different origin", async () => {
    const { blob } = await makeDelegation({ domain: "evil.example" });
    expect(verifyDelegation(blob, { nowSec: NOW + 60, expectedDomain: DOMAIN })).toBeNull();
  });

  test("accepts any listed domain, and still rejects one not on the list", async () => {
    const { blob } = await makeDelegation({ domain: "www.siphon.money" });
    expect(verifyDelegation(blob, { nowSec: NOW + 60, expectedDomain: [DOMAIN, "www.siphon.money"] })).not.toBeNull();
    expect(verifyDelegation(blob, { nowSec: NOW + 60, expectedDomain: [DOMAIN, "siphon.money"] })).toBeNull();
  });

  test("rejects a tampered session address", async () => {
    const { blob } = await makeDelegation();
    const parsed = JSON.parse(blob);
    parsed.sessionAddress = Wallet.createRandom().address; // attacker swaps in their own key
    const tampered = JSON.stringify(parsed);
    expect(verifyDelegation(tampered, { nowSec: NOW + 60, expectedDomain: DOMAIN })).toBeNull();
  });

  test("rejects a tampered wallet address", async () => {
    const { blob } = await makeDelegation();
    const parsed = JSON.parse(blob);
    parsed.wallet = Wallet.createRandom().address.toLowerCase();
    expect(
      verifyDelegation(JSON.stringify(parsed), { nowSec: NOW + 60, expectedDomain: DOMAIN }),
    ).toBeNull();
  });

  test("rejects a delegation signed by someone other than the claimed wallet", async () => {
    const impostor = Wallet.createRandom();
    const victim = Wallet.createRandom();
    const session = Wallet.createRandom();
    const unsigned = {
      sessionAddress: session.address,
      wallet: victim.address.toLowerCase(), // claims the victim
      chainId: 8453,
      domain: DOMAIN,
      issuedAt: NOW,
      expiresAt: NOW + SESSION_MAX_AGE_SEC,
      nonce: "n",
    };
    const signature = await impostor.signMessage(buildDelegationMessage(unsigned as never));
    const blob = JSON.stringify({ ...unsigned, signature });
    expect(verifyDelegation(blob, { nowSec: NOW + 60, expectedDomain: DOMAIN })).toBeNull();
  });

  test("rejects malformed input rather than throwing", () => {
    for (const bad of ["", "{", "null", "[]", '{"wallet":"0x1"}', "not json at all"]) {
      expect(verifyDelegation(bad, { nowSec: NOW, expectedDomain: DOMAIN })).toBeNull();
    }
  });

  test("the signed message states that spending is not authorized", () => {
    // The user's only defence against signing something they misunderstand is the text itself.
    const msg = buildDelegationMessage({
      sessionAddress: "0x" + "1".repeat(40),
      wallet: "0x" + "2".repeat(40),
      chainId: 8453,
      domain: DOMAIN,
      issuedAt: NOW,
      expiresAt: NOW + 3600,
      nonce: "n",
    } as never);
    expect(msg).toContain("does NOT authorize spending");
    expect(msg).toContain(DOMAIN);
    expect(msg).toContain("zero-knowledge proof");
  });
});

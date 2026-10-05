/**
 * End-to-end: does a session-key-signed request actually authenticate, and do the attacks fail?
 *
 * sessionKey.test.ts covers the delegation blob in isolation. This covers the server verifier
 * consuming it — the path a real request takes — including that the OMEGA-01 request binding still
 * holds when the signer is a session key rather than the wallet.
 */
import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { NextRequest } from "next/server";

import {
  PRIVILEGED_REQ_PREFIX,
  WALLET_AUTH_MESSAGE_PREFIX,
  sha256HexUtf8,
  verifyPrivilegedWalletAuthHeaders,
  verifyWalletAuthHeaders,
} from "../apiWalletAuth";
import { SESSION_HEADER, SESSION_MAX_AGE_SEC, buildDelegationMessage } from "../sessionKey";

const NOW = 1_800_000_000;
const HOST = "siphon.money";
const ENV = { API_WALLET_AUTH_REQUIRED: "1", NODE_ENV: "production" } as NodeJS.ProcessEnv;

async function delegation(walletKey: Wallet, sessionAddress: string, over = {}) {
  const unsigned = {
    sessionAddress,
    wallet: walletKey.address.toLowerCase(),
    chainId: 8453,
    domain: HOST,
    issuedAt: NOW,
    expiresAt: NOW + SESSION_MAX_AGE_SEC,
    nonce: "n",
    ...over,
  };
  const signature = await walletKey.signMessage(buildDelegationMessage(unsigned as never));
  return JSON.stringify({ ...unsigned, signature });
}

function req(headers: Record<string, string>, url = `https://${HOST}/api/graph`) {
  return new NextRequest(url, { method: "POST", headers: { host: HOST, ...headers } });
}

describe("session-key auth, end to end", () => {
  test("a session key authenticates for its delegating wallet", async () => {
    const walletKey = Wallet.createRandom();
    const sessionKey = Wallet.createRandom();
    const ts = String(NOW);
    const sig = await sessionKey.signMessage(`${WALLET_AUTH_MESSAGE_PREFIX}:${ts}`);

    const res = verifyWalletAuthHeaders(
      req({
        "x-wallet-address": walletKey.address.toLowerCase(),
        "x-signature": sig,
        "x-timestamp": ts,
        [SESSION_HEADER]: await delegation(walletKey, sessionKey.address),
      }),
      ENV,
      NOW + 30,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.wallet).toBe(walletKey.address.toLowerCase());
  });

  test("the direct wallet path still works with no delegation present", async () => {
    // The whole migration is additive; breaking this breaks every un-migrated caller and SDK.
    const walletKey = Wallet.createRandom();
    const ts = String(NOW);
    const sig = await walletKey.signMessage(`${WALLET_AUTH_MESSAGE_PREFIX}:${ts}`);
    const res = verifyWalletAuthHeaders(
      req({
        "x-wallet-address": walletKey.address.toLowerCase(),
        "x-signature": sig,
        "x-timestamp": ts,
      }),
      ENV,
      NOW + 30,
    );
    expect(res.ok).toBe(true);
  });

  test("a session key CANNOT act for a wallet that never delegated to it", async () => {
    const victim = Wallet.createRandom();
    const attackerSession = Wallet.createRandom();
    const ts = String(NOW);
    const sig = await attackerSession.signMessage(`${WALLET_AUTH_MESSAGE_PREFIX}:${ts}`);
    // Delegation is for a DIFFERENT wallet than the header claims.
    const other = Wallet.createRandom();
    const res = verifyWalletAuthHeaders(
      req({
        "x-wallet-address": victim.address.toLowerCase(),
        "x-signature": sig,
        "x-timestamp": ts,
        [SESSION_HEADER]: await delegation(other, attackerSession.address),
      }),
      ENV,
      NOW + 30,
    );
    expect(res.ok).toBe(false);
  });

  test("a stolen delegation alone is useless without the session private key", async () => {
    // Delegations are sent on every request, so they are not secret. Holding one must not be
    // enough — the request signature has to come from the delegated key itself.
    const walletKey = Wallet.createRandom();
    const sessionKey = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const ts = String(NOW);
    const sig = await attacker.signMessage(`${WALLET_AUTH_MESSAGE_PREFIX}:${ts}`);
    const res = verifyWalletAuthHeaders(
      req({
        "x-wallet-address": walletKey.address.toLowerCase(),
        "x-signature": sig,
        "x-timestamp": ts,
        [SESSION_HEADER]: await delegation(walletKey, sessionKey.address),
      }),
      ENV,
      NOW + 30,
    );
    expect(res.ok).toBe(false);
  });

  test("an expired delegation stops authenticating", async () => {
    const walletKey = Wallet.createRandom();
    const sessionKey = Wallet.createRandom();
    const late = NOW + SESSION_MAX_AGE_SEC + 10;
    const ts = String(late);
    const sig = await sessionKey.signMessage(`${WALLET_AUTH_MESSAGE_PREFIX}:${ts}`);
    const res = verifyWalletAuthHeaders(
      req({
        "x-wallet-address": walletKey.address.toLowerCase(),
        "x-signature": sig,
        "x-timestamp": ts,
        [SESSION_HEADER]: await delegation(walletKey, sessionKey.address),
      }),
      ENV,
      late,
    );
    expect(res.ok).toBe(false);
  });

  test("OMEGA-01 body binding still holds for session-signed requests", async () => {
    const walletKey = Wallet.createRandom();
    const sessionKey = Wallet.createRandom();
    const ts = String(NOW);
    const body = JSON.stringify({ amount: "1" });
    const hash = sha256HexUtf8(body);
    const path = "/api/graph";
    const msg = `${PRIVILEGED_REQ_PREFIX}:POST:${path}:${hash}:${ts}`;
    const sig = await sessionKey.signMessage(msg);
    const del = await delegation(walletKey, sessionKey.address);

    const headers = {
      "x-wallet-address": walletKey.address.toLowerCase(),
      "x-signature": sig,
      "x-timestamp": ts,
      "x-body-sha256": hash,
      [SESSION_HEADER]: del,
    };

    // Correct body: accepted.
    expect(
      verifyPrivilegedWalletAuthHeaders(req(headers), body, ENV, NOW + 10).ok,
    ).toBe(true);

    // A DIFFERENT body with the same signature: rejected. The session key changes who may sign,
    // never what the signature commits to.
    expect(
      verifyPrivilegedWalletAuthHeaders(
        req({ ...headers, "x-body-sha256": sha256HexUtf8('{"amount":"999"}') }),
        '{"amount":"999"}',
        ENV,
        NOW + 10,
      ).ok,
    ).toBe(false);
  });
});

describe("cached auth headers carry the delegation", () => {
  test("a cached session-signed bundle still authenticates", async () => {
    // Regression guard. getCachedWalletAuthHeaders is synchronous and cannot sign — seven call
    // sites (decryptorClient, strategyApi, strategySubmit, fheKeyWarmup, strategyAuthorizer,
    // polymarketPositions) only read the cache. When session-signed headers were cached WITHOUT
    // their delegation, the server recovered the ephemeral address, could not tie it to the
    // wallet, and 401'd every one of those calls. The delegation must ride along.
    const walletKey = Wallet.createRandom();
    const sessionKey = Wallet.createRandom();
    const ts = String(NOW);
    const sig = await sessionKey.signMessage(`${WALLET_AUTH_MESSAGE_PREFIX}:${ts}`);
    const del = await delegation(walletKey, sessionKey.address);

    // Headers exactly as the cache would hand them back.
    const cached = {
      "x-wallet-address": walletKey.address.toLowerCase(),
      "x-signature": sig,
      "x-timestamp": ts,
      [SESSION_HEADER]: del,
    };
    expect(verifyWalletAuthHeaders(req(cached), ENV, NOW + 30).ok).toBe(true);

    // The same bundle WITHOUT the delegation is the bug: rejected.
    const { [SESSION_HEADER]: _dropped, ...noDelegation } = cached;
    expect(verifyWalletAuthHeaders(req(noDelegation), ENV, NOW + 30).ok).toBe(false);
  });
});

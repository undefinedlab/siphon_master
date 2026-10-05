/**
 * Phantom (ed25519) privileged auth: a Solana wallet authenticates the same request-bound and
 * session messages an EVM wallet signs, and none of the binding guarantees weaken.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";

import {
  PRIVILEGED_REQ_PREFIX,
  isSolanaWalletAddress,
  sha256HexUtf8,
  verifyPrivilegedWalletAuthHeaders,
} from "../apiWalletAuth";
import { requireWalletMatch } from "../privilegedProxyGate";
import { solanaExecutorSessionMessage } from "../solanaWalletAuth";

const NOW = 1_800_000_000;
const HOST = "siphon.money";
const ENV = { API_WALLET_AUTH_REQUIRED: "1", NODE_ENV: "production" } as NodeJS.ProcessEnv;

function phantomKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const wallet = new PublicKey(raw).toBase58();
  const signB64 = (message: string) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
  return { wallet, signB64 };
}

function req(headers: Record<string, string>, url: string, method = "POST") {
  return new NextRequest(url, { method, headers: { host: HOST, ...headers } });
}

describe("Solana privileged wallet auth", () => {
  test("recognises base58 pubkeys, not 0x addresses", () => {
    expect(isSolanaWalletAddress(phantomKey().wallet)).toBe(true);
    expect(isSolanaWalletAddress("0x1111111111111111111111111111111111111111")).toBe(false);
  });

  test("request-bound signature authenticates and keeps base58 case", () => {
    const k = phantomKey();
    const body = JSON.stringify({ chainId: 900002, depositor: k.wallet });
    const hash = sha256HexUtf8(body);
    const ts = String(NOW);
    const msg = `${PRIVILEGED_REQ_PREFIX}:POST:/api/asp-screen:${hash}:${ts}`;
    const out = verifyPrivilegedWalletAuthHeaders(
      req(
        { "x-wallet-address": k.wallet, "x-signature": k.signB64(msg), "x-timestamp": ts, "x-body-sha256": hash },
        `https://${HOST}/api/asp-screen`,
      ),
      body,
      ENV,
      NOW + 5,
    );
    expect(out).toEqual({ ok: true, wallet: k.wallet });
  });

  test("session signature authenticates an allowlisted route", () => {
    const k = phantomKey();
    const ts = String(NOW);
    const out = verifyPrivilegedWalletAuthHeaders(
      req(
        {
          "x-wallet-address": k.wallet,
          "x-signature": k.signB64(`Siphon auth v1:session:/api/asp-set/path:${ts}`),
          "x-timestamp": ts,
          "x-auth-mode": "session",
          "x-body-sha256": "session",
        },
        `https://${HOST}/api/asp-set/path?label=1&chainId=900002`,
        "GET",
      ),
      "",
      ENV,
      NOW + 5,
    );
    expect(out.ok).toBe(true);
  });

  test("a body swap under the same signature is rejected", () => {
    const k = phantomKey();
    const signedBody = JSON.stringify({ depositor: k.wallet });
    const hash = sha256HexUtf8(signedBody);
    const ts = String(NOW);
    const sig = k.signB64(`${PRIVILEGED_REQ_PREFIX}:POST:/api/asp-screen:${hash}:${ts}`);
    const out = verifyPrivilegedWalletAuthHeaders(
      req({ "x-wallet-address": k.wallet, "x-signature": sig, "x-timestamp": ts }, `https://${HOST}/api/asp-screen`),
      JSON.stringify({ depositor: "someone-else" }),
      ENV,
      NOW + 5,
    );
    expect(out.ok).toBe(false);
  });

  test("another key's signature does not authenticate the claimed wallet", () => {
    const victim = phantomKey();
    const attacker = phantomKey();
    const ts = String(NOW);
    const out = verifyPrivilegedWalletAuthHeaders(
      req(
        {
          "x-wallet-address": victim.wallet,
          "x-signature": attacker.signB64(`Siphon auth v1:session:/api/asp-screen:${ts}`),
          "x-timestamp": ts,
          "x-auth-mode": "session",
          "x-body-sha256": "session",
        },
        `https://${HOST}/api/asp-screen`,
      ),
      "",
      ENV,
      NOW + 5,
    );
    expect(out.ok).toBe(false);
  });

  test("a lowercased base58 wallet is not accepted as the same wallet", () => {
    const k = phantomKey();
    expect(requireWalletMatch(k.wallet, k.wallet, "depositor")).toBeNull();
    const lowered = k.wallet.toLowerCase();
    if (lowered !== k.wallet) {
      expect(requireWalletMatch(k.wallet, lowered, "depositor")).not.toBeNull();
    }
  });

  test("the Devnet session opens allowlisted proxies only, for its wallet, until it expires", () => {
    const k = phantomKey();
    const other = phantomKey();
    const expires = NOW + 3600;
    const session = (signer: ReturnType<typeof phantomKey>, wallet: string, exp: number) => ({
      "x-solana-address": wallet,
      "x-solana-session": signer.signB64(solanaExecutorSessionMessage(wallet, exp)),
      "x-solana-expires": String(exp),
    });
    const check = (headers: Record<string, string>, path: string, now = NOW) =>
      verifyPrivilegedWalletAuthHeaders(req(headers, `https://${HOST}${path}`, "GET"), "", ENV, now);

    expect(check(session(k, k.wallet, expires), "/api/asp-set/root?chainId=900002")).toEqual({ ok: true, wallet: k.wallet });
    expect(check(session(k, k.wallet, expires), "/api/prove").ok).toBe(false);
    expect(check(session(k, k.wallet, expires), "/api/asp-admit").ok).toBe(false);
    expect(check(session(k, k.wallet, expires), "/api/asp-set/root", expires + 1).ok).toBe(false);
    expect(check(session(k, k.wallet, NOW + 3 * 86400), "/api/asp-set/root").ok).toBe(false);
    expect(check(session(other, k.wallet, expires), "/api/asp-set/root").ok).toBe(false);
  });
});

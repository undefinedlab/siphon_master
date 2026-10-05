// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { afterEach, describe, expect, test } from "bun:test";
import { verifyAspRootsCurrent } from "../aspRootFreshness";

const RPC = process.env.BASE_MAINNET_RPC;
const HUB = process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB;

afterEach(() => {
  if (RPC === undefined) delete process.env.BASE_MAINNET_RPC;
  else process.env.BASE_MAINNET_RPC = RPC;
  if (HUB === undefined) delete process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB;
  else process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB = HUB;
});

function configureBase() {
  process.env.BASE_MAINNET_RPC = "https://rpc.invalid";
  process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB = "0x1111111111111111111111111111111111111111";
}

function rootFetcher(admitted: bigint, revoked: bigint): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { params: Array<{ data: string }> };
    const selector = request.params[0]?.data;
    const value = selector === "0xf7956093" ? admitted : revoked;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${value.toString(16)}` }));
  }) as typeof fetch;
}

describe("ASP root freshness gate", () => {
  test("accepts roots that match the selected Base hub", async () => {
    configureBase();
    const result = await verifyAspRootsCurrent(
      "8453",
      { admittedRoot: "123", revokedRoot: "456" },
      rootFetcher(123n, 456n),
    );
    expect(result).toEqual({ ok: true });
  });

  test("turns cross-chain publication skew into publish_pending", async () => {
    configureBase();
    const result = await verifyAspRootsCurrent(
      "8453",
      { admittedRoot: "123", revokedRoot: "456" },
      rootFetcher(122n, 456n),
    );
    expect(result).toEqual({ ok: false, error: "publish_pending" });
  });

  test("falls back to a public RPC when the configured key is out of quota", async () => {
    configureBase();
    const healthy = rootFetcher(123n, 456n);
    const seen: string[] = [];
    const quotaThenPublic = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      if (String(url) === "https://rpc.invalid") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "User balance exceeded", code: 10 } }), { status: 403 });
      }
      return healthy(url, init);
    }) as typeof fetch;
    const result = await verifyAspRootsCurrent(
      "8453",
      { admittedRoot: "123", revokedRoot: "456" },
      quotaThenPublic,
    );
    expect(result).toEqual({ ok: true });
    expect(seen[0]).toBe("https://rpc.invalid");
  });

  test("a fallback RPC does not mask a root mismatch", async () => {
    configureBase();
    const result = await verifyAspRootsCurrent(
      "8453",
      { admittedRoot: "123", revokedRoot: "456" },
      rootFetcher(999n, 456n),
    );
    expect(result).toEqual({ ok: false, error: "publish_pending" });
  });

  test("fails closed when the hub RPC cannot be checked", async () => {
    configureBase();
    const unavailable = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const result = await verifyAspRootsCurrent(
      "8453",
      { admittedRoot: "123" },
      unavailable,
    );
    expect(result).toEqual({ ok: false, error: "root_check_unavailable" });
  });
});

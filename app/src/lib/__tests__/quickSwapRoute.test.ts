// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { quickSwapRoute } from "../quickSwapRoute";

/**
 * A Quick Swap on Base scanned the v1 Entrypoint's 17-leaf tree for 51 seconds and failed with
 * `readNoteLoop(0 candidates)` — while the user's 3 USDC sat in the v3 kernel's 40-leaf tree.
 * Quick Swap was the only arming entry point without the v3 dispatch that DetailsModal and Build
 * already had.
 */

describe("quickSwapRoute", () => {
  test("a real swap on a v3 chain arms through the enclave", () => {
    expect(quickSwapRoute(false, true)).toBe("v3");
  });

  test("a real swap on a pre-v3 chain keeps the legacy atomic path", () => {
    expect(quickSwapRoute(false, false)).toBe("v2-swap");
  });

  test("a v3 chain NEVER routes to a v2 path — that is the whole bug", () => {
    for (const sameAsset of [true, false]) {
      expect(quickSwapRoute(sameAsset, true)).not.toBe("v2-swap");
      expect(quickSwapRoute(sameAsset, true)).not.toBe("v2-same-asset");
    }
  });

  test("swapping an asset for itself is refused on v3 rather than run against the wrong vault", () => {
    expect(quickSwapRoute(true, true)).toBe("same-asset-unsupported");
  });

  test("the legacy same-asset re-shield still works where v3 is not deployed", () => {
    expect(quickSwapRoute(true, false)).toBe("v2-same-asset");
  });
});

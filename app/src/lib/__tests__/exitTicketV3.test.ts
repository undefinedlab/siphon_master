// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { Interface } from "ethers";

import { v3DepositUserSaltMatches } from "../aspAdmitReceipt";
import { aspPostmanProxyHeaders } from "../aspServerUrl";
import { userSaltFromDepositCalldata } from "../v3/exitTicketV3";
import {
  RAGEQUIT_GRACE_SECONDS,
  noteRagequitGrace,
  withinRagequitGrace,
} from "../v3/ragequitGraceV3";

const iface = new Interface([
  "function deposit(address token, uint256 amount, uint256 userSalt, uint256 precommitment)",
  "function depositNative(uint256 userSalt, uint256 precommitment) payable",
]);

describe("v3 exit-ticket deposit metadata", () => {
  test("sends the scoped postman header required by the production ASP proxy", () => {
    const previous = process.env.ASP_POSTMAN_TOKEN;
    process.env.ASP_POSTMAN_TOKEN = "test-postman-token";
    try {
      const headers = aspPostmanProxyHeaders();
      expect(headers.Authorization).toBe("Bearer test-postman-token");
      expect(headers["X-Asp-Postman-Token"]).toBe("test-postman-token");
    } finally {
      if (previous === undefined) delete process.env.ASP_POSTMAN_TOKEN;
      else process.env.ASP_POSTMAN_TOKEN = previous;
    }
  });

  test("recovers userSalt from an ERC-20 deposit transaction", () => {
    const data = iface.encodeFunctionData("deposit", [
      "0x1111111111111111111111111111111111111111",
      1_000_000n,
      987654321n,
      123n,
    ]);
    expect(userSaltFromDepositCalldata(data)).toBe("987654321");
  });

  test("recovers userSalt from a native deposit transaction", () => {
    const data = iface.encodeFunctionData("depositNative", [444n, 555n]);
    expect(userSaltFromDepositCalldata(data)).toBe("444");
  });

  test("rejects unrelated calldata", () => {
    expect(userSaltFromDepositCalldata("0x12345678")).toBeNull();
  });

  test("server verifier binds the exit ticket to the exact calldata salt", () => {
    const data = iface.encodeFunctionData("depositNative", [444n, 555n]);
    expect(v3DepositUserSaltMatches(data, "444")).toBe(true);
    expect(v3DepositUserSaltMatches(data, "445")).toBe(false);
    expect(v3DepositUserSaltMatches("0x12345678", "444")).toBe(false);
  });
});

describe("v3 ragequit grace period", () => {
  test("includes the complete five-minute boundary and expires afterward", () => {
    expect(withinRagequitGrace(1_000, 1_000 + RAGEQUIT_GRACE_SECONDS)).toBe(true);
    expect(withinRagequitGrace(1_000, 1_001 + RAGEQUIT_GRACE_SECONDS)).toBe(false);
  });

  test("uses the mined timestamp before the local fallback", () => {
    expect(
      noteRagequitGrace({
        depositTimestampSeconds: 1_000,
        createdAtMs: 2_000_000,
        nowMs: 1_250_000,
      }).active,
    ).toBe(true);
  });
});

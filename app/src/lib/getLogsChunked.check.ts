// Runnable regression check (this repo intentionally has no unit-test runner):
//   npx tsx src/lib/getLogsChunked.check.ts
import assert from "node:assert/strict";
import type { ethers } from "ethers";
import { getLogsChunked } from "./getLogsChunked";

const requested: Array<[number, number]> = [];
const provider = {
  async getLogs(filter: ethers.Filter): Promise<ethers.Log[]> {
    const from = Number(filter.fromBlock);
    const to = Number(filter.toBlock);
    requested.push([from, to]);
    if (to - from + 1 > 3) {
      throw { code: -32603, data: { code: -32701, message: "exceed maximum block range: 3" } };
    }
    return [];
  },
};

async function main() {
  await getLogsChunked(
    provider,
    { address: "0x0000000000000000000000000000000000000001", topics: ["0x01"] },
    100,
    109,
    10,
  );

  const successful = requested.filter(([from, to]) => to - from + 1 <= 3);
  assert.deepEqual(successful, [[100, 101], [102, 103], [104, 105], [106, 107], [108, 109]]);
  assert(successful.every(([from, to]) => from >= 100 && to <= 109));

  let transportCalls = 0;
  const brokenProvider = {
    async getLogs(): Promise<ethers.Log[]> {
      transportCalls++;
      throw { code: -32080, message: "RPC endpoint returned HTTP client error" };
    },
  };
  await assert.rejects(() =>
    getLogsChunked(
      brokenProvider,
      { address: "0x0000000000000000000000000000000000000001", topics: ["0x01"] },
      100,
      109,
      10,
    ),
  );
  assert.equal(transportCalls, 1, "transport errors must not trigger progressively smaller scans");
  console.log("OK — oversized eth_getLogs ranges shrink and scan the requested blocks exactly once");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

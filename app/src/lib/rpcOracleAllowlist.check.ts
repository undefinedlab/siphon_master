/**
 * The sanctions oracle must survive the /api/rpc call-target allowlist.
 *
 * isSanctioned() runs before every deposit and screens the depositor. Its address was private to
 * sanctionsScreen.ts, so rpcContractAllowlist() never included it: in production the allowlist is
 * enforced by default, the eth_call came back 403 rpc_target_forbidden, and the screen failed
 * CLOSED — refusing every deposit with "Sanctions oracle unavailable for chain 8453 — deposits
 * paused until RPC recovers" while the RPC was healthy.
 *
 * Run: bunx tsx src/lib/rpcOracleAllowlist.check.ts
 */
import assert from "node:assert";
import { rpcContractAllowlist, rpcTargetsAllowed } from "./rpcHttpGuard";
import { ORACLE_CHAINS, oracleAddressFor } from "./sanctionsOracles";

const PROD = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;

// Every oracle chain must allow its own oracle — including the Base override, which differs from
// the default deployment. Getting that pairing backwards allowlists an address nothing calls.
for (const chainId of ORACLE_CHAINS) {
  const oracle = oracleAddressFor(chainId).toLowerCase();
  assert.ok(
    rpcContractAllowlist(chainId, PROD).has(oracle),
    `chain ${chainId}: oracle ${oracle} missing from the allowlist`,
  );
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: oracle, data: "0xdf592f7d" }, "latest"],
  });
  assert.ok(
    rpcTargetsAllowed(body, chainId, PROD),
    `chain ${chainId}: eth_call to the oracle was refused`,
  );
}

// Base's oracle is a different contract from the default — assert they really are distinct, or
// this test would pass just as happily against a single hardcoded address.
assert.notStrictEqual(
  oracleAddressFor(8453).toLowerCase(),
  oracleAddressFor(1).toLowerCase(),
  "Base override collapsed into the default — the per-chain mapping is not being applied",
);

// The allowlist must still REFUSE an unrelated contract, or it is not an allowlist any more.
const evil = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [{ to: "0x000000000000000000000000000000000000dead", data: "0x" }, "latest"],
});
assert.ok(!rpcTargetsAllowed(evil, 8453, PROD), "allowlist accepted an unlisted contract");

// The state-leaf fallback rebuilds the tree from NoteTree.CommitmentInserted, so it issues
// eth_getLogs against the NoteTree — a DIFFERENT allowlist path from eth_call (filter.address, not
// params[0].to). Nothing covered eth_getLogs, and the fallback shipped unable to make its own call:
// 403 rpc_target_forbidden, failing closed into the same "state leaves unavailable" it was meant
// to cure. Assert the address the fallback actually uses, on the method it actually uses.
const NOTE_TREE: Record<number, string> = {
  8453: "0x0F345A17DCd7E37E6952cA8175B827970cbD7064",
  11155111: "0x24934c8cBee549eEca27bBD0258db9648A677a7F",
};
for (const [chain, tree] of Object.entries(NOTE_TREE)) {
  const chainId = Number(chain);
  const env = {
    NODE_ENV: "production",
    NEXT_PUBLIC_V3_BASE_NOTE_TREE: NOTE_TREE[8453],
    NEXT_PUBLIC_V3_SEPOLIA_NOTE_TREE: NOTE_TREE[11155111],
  } as unknown as NodeJS.ProcessEnv;
  const logs = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getLogs",
    params: [{ address: tree, fromBlock: "0x1", toBlock: "0x2" }],
  });
  assert.ok(
    rpcTargetsAllowed(logs, chainId, env),
    `chain ${chainId}: eth_getLogs on the NoteTree ${tree} was refused — the state-leaf fallback cannot run`,
  );
}

// The nullifier reconcile must reach the NullifierSet. It fails open, so a refusal here does not
// error — it silently double-counts a spent note in the balance.
const NULLIFIER_SET: Record<number, string> = {
  8453: "0xBCe9966e70A854FC3e3a93a806bDC49AD7272fF0",
  11155111: "0xE33Ef6853c6092693dE2838453392ceE20580000",
};
for (const [chain, addr] of Object.entries(NULLIFIER_SET)) {
  const env = {
    NODE_ENV: "production",
    NEXT_PUBLIC_V3_BASE_NULLIFIER_SET: NULLIFIER_SET[8453],
    NEXT_PUBLIC_V3_SEPOLIA_NULLIFIER_SET: NULLIFIER_SET[11155111],
  } as unknown as NodeJS.ProcessEnv;
  const call = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: addr, data: "0x0e6f0ad3" }, "latest"],
  });
  assert.ok(
    rpcTargetsAllowed(call, Number(chain), env),
    `chain ${chain}: eth_call to NullifierSet ${addr} refused — spent notes will double-count`,
  );
}

// An unfiltered log scan must still be refused, or the allowlist has been traded for an archive bill.
assert.ok(
  !rpcTargetsAllowed(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x1" }] }),
    8453,
    PROD,
  ),
  "unfiltered eth_getLogs must stay refused",
);

console.log(
  "rpcOracleAllowlist.check: OK — oracle + NullifierSet eth_call and NoteTree eth_getLogs allowed " +
    "on both v3 chains, unlisted targets and unfiltered log scans still refused",
);

// Runnable self-check: the zkey a chain proves with must match the verifier deployed on it.
//   npx tsx src/lib/v3/zkKeyParity.check.ts
//
// This is the check that was missing when a Base withdraw died as an HTTP 502 from the relayer.
// A Groth16 phase-2 ceremony fixes `delta`; a verifier accepts proofs only from the zkey it came
// from. Everything else about the two key sets is identical — same circuits, so alpha, beta, gamma
// and IC all match byte for byte — which is what makes the failure so quiet:
//
//   • the witness is correct
//   • the public inputs are correct
//   • the browser's own local verify PASSES, because it checks the proof against the same vkey it
//     proved with, so a wrong-but-self-consistent key set sails through every client-side gate
//   • the kernel reverts ProofFailed(), four layers down, surfacing as "executor relaySpend failed
//     (HTTP 502)" — a message that points at the relayer, not at the keys
//
// So the only place the mismatch is visible is against the chain. This check does that: it reads
// each deployed sub-verifier's bytecode and asserts the delta of the key set we would actually
// serve that chain is present in it, and (the half that catches a silent regression) that the
// OTHER key set's delta is not.
//
// Offline (no RPC) it still verifies the local invariant that the two sets differ in delta and
// agree everywhere else — enough to catch "someone copied dev-beacon into /zk/ceremony".
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { id } from "ethers";

const RPC: Record<number, string | undefined> = {
  8453: process.env.BASE_MAINNET_RPC,
  42161: process.env.ARBITRUM_RPC,
};
/** Mirrors CEREMONY_VERIFIER_CHAINS in configV3.ts. */
const CEREMONY_CHAINS = new Set([8453, 42161]);
const ROUTER: Record<number, string> = {
  // VerifierRegistry.verifiers(PROGRAM_VERSION_V3=5), read back from the live v5 registry.
  8453: "0xd5439d77B073a06FbC0b6F04A04Bb54b2Db8bd5C",
  // Arbitrum v5 SpendActionGroth16Router (registered as verifiers(5) by the Safe, 2026-09-28).
  42161: "0x24C02c0ab5cE2A63E9BE76F0decBDA41B173903B",
};
const CIRCUITS = ["withdraw1", "withdraw2", "split", "swap"];

const pub = (base: string, c: string) =>
  path.join(process.cwd(), "public/zk", base, c, "verification_key.json");

type Vk = { vk_alpha_1: string[]; vk_beta_2: string[][]; vk_gamma_2: string[][]; vk_delta_2: string[][]; IC: string[][] };
const readVk = (base: string, c: string): Vk => JSON.parse(fs.readFileSync(pub(base, c), "utf8"));
const word = (v: string) => BigInt(v).toString(16).padStart(64, "0");

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/**
 * The router exposes each sub-verifier as an immutable public getter named after the circuit, so
 * the selector is just keccak("<circuit>()")[0:4]. Derived, never hardcoded — a wrong literal here
 * would read some other slot and "pass" against the wrong contract entirely.
 */
const selectorFor = (circuit: string) => id(`${circuit}()`).slice(0, 10);

async function main() {
  // --- offline: the two key sets must differ in delta and ONLY in delta -----------------------
  let compared = 0;
  for (const c of CIRCUITS) {
    if (!fs.existsSync(pub("ceremony", c))) continue;
    const dev = readVk(".", c);
    const cer = readVk("ceremony", c);

    assert.notStrictEqual(
      word(cer.vk_delta_2[0][0]), word(dev.vk_delta_2[0][0]),
      `${c}: /zk/ceremony has the SAME delta as /zk — one key set was copied over the other, ` +
        `and every chain now proves with the wrong keys for one of them`,
    );
    // Same circuit ⇒ everything a phase-2 ceremony does NOT touch must be identical. If these
    // drift, the two trees are different CIRCUITS and the mismatch is far worse than a bad delta.
    for (const [name, a, b] of [
      ["alpha_1", dev.vk_alpha_1[0], cer.vk_alpha_1[0]],
      ["beta_2", dev.vk_beta_2[0][0], cer.vk_beta_2[0][0]],
      ["gamma_2", dev.vk_gamma_2[0][0], cer.vk_gamma_2[0][0]],
      ["IC[1]", dev.IC[1][0], cer.IC[1][0]],
    ] as const) {
      assert.strictEqual(word(a), word(b), `${c}: ${name} differs — these are not the same circuit`);
    }
    assert.strictEqual(dev.IC.length, cer.IC.length, `${c}: IC length differs`);
    compared++;
  }
  assert.ok(compared > 0, "no ceremony vkeys found under public/zk/ceremony — install them first");

  // --- online: the delta we serve each chain must be the delta ITS verifier holds --------------
  let onchain = 0;
  for (const [chain, url] of Object.entries(RPC)) {
    const chainId = Number(chain);
    if (!url) {
      console.log(`  (chain ${chainId}: no RPC in env, skipping the on-chain half)`);
      continue;
    }
    const expected = CEREMONY_CHAINS.has(chainId) ? "ceremony" : ".";
    const other = expected === "ceremony" ? "." : "ceremony";
    for (const c of CIRCUITS) {
      const addr =
        "0x" + (await rpc(url, "eth_call", [{ to: ROUTER[chainId], data: selectorFor(c) }, "latest"])).slice(-40);
      const code = await rpc(url, "eth_getCode", [addr, "latest"]);
      assert.ok(
        code.includes(word(readVk(expected, c).vk_delta_2[0][0])),
        `chain ${chainId} ${c}: verifier ${addr} does NOT hold the delta from /zk/${expected} — ` +
          `zkProvingBase(${chainId}) is serving the wrong key set and every proof will revert ProofFailed()`,
      );
      assert.ok(
        !code.includes(word(readVk(other, c).vk_delta_2[0][0])),
        `chain ${chainId} ${c}: verifier also holds the /zk/${other} delta — impossible, check the router`,
      );
      onchain++;
    }
  }

  // --- Solana devnet vault: its VK PDA must hold the delta of the set zkProvingBase(900002) serves
  const solRpc = process.env.SOLANA_RPC_URL;
  if (solRpc) {
    const { PublicKey } = await import("@solana/web3.js");
    const { SOLANA_DEVNET_ZK_PROGRAM_ID } = await import("../chains/solanaZkProgram");
    const [vkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("siphon-vk-v1"), Buffer.from([0])], // CIRCUITS[0] on the program = withdraw1
      new PublicKey(SOLANA_DEVNET_ZK_PROGRAM_ID),
    );
    const acct = (await rpc(solRpc, "getAccountInfo", [vkPda.toBase58(), { encoding: "base64" }])) as unknown as {
      value: { data: [string, string] };
    };
    const data = Buffer.from(acct.value.data[0], "base64").toString("hex");
    const expected = CEREMONY_CHAINS.has(900002) ? "ceremony" : ".";
    assert.ok(
      data.includes(word(readVk(expected, "withdraw1").vk_delta_2[0][0])),
      `Solana devnet withdraw1 VK PDA ${vkPda.toBase58()} does NOT hold the /zk/${expected} delta`,
    );
    onchain++;
  } else {
    console.log("  (Solana: no SOLANA_RPC_URL in env, skipping)");
  }

  console.log(
    `zkKeyParity.check: OK — ${compared} circuits differ in delta only, ` +
      (onchain ? `${onchain} deployed verifiers match the key set they are served` : "on-chain half skipped"),
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

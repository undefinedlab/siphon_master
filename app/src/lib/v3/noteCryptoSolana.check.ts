// Runnable self-check: app Solana identity vs shared chain-profile-solana.json.
//   npx tsx src/lib/v3/noteCryptoSolana.check.ts
//
// Closes the vector-parity triangle with spend-core SolanaProfile and siphon-vault payee codec.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOMAIN_CHAIN_SOL,
  DOMAIN_PAYEE_SOL_COMPRESS,
  DOMAIN_VAULT_SCOPE,
  poseidon2,
  poseidon3,
  vaultScopeIdSolana,
} from "./noteCryptoV3";
import { DOMAIN_PAYEE, payeeIdSolana } from "./payeeV3";

const VECTORS = join(__dirname, "..", "..", "..", "..", "siphon-zk-v2", "test-vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VECTORS, f), "utf8"));

function hexToBytes32(hex: string): Uint8Array {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length !== 64) throw new Error(`expected 32-byte hex, got len=${raw.length}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function main() {
  const domains = load("domains.json");
  assert.equal(DOMAIN_CHAIN_SOL.toString(), domains.DOMAIN_CHAIN_SOL);
  assert.equal(DOMAIN_PAYEE_SOL_COMPRESS.toString(), domains.DOMAIN_PAYEE_SOL_COMPRESS);
  assert.equal(DOMAIN_PAYEE.toString(), domains.DOMAIN_PAYEE);

  const profile = load("chain-profile-solana.json");
  const programId = hexToBytes32(profile.programIdBytes32);
  const vaultPda = hexToBytes32(profile.vaultPdaBytes32);
  const payee = hexToBytes32(profile.payeePubkeyBytes32);

  const scope = await vaultScopeIdSolana(programId, vaultPda);
  assert.equal(
    scope.toString(),
    profile.vaultScopeId,
    "vaultScopeIdSolana != chain-profile-solana.json",
  );

  // ChainProfile::mint_label = Poseidon(DOMAIN_VAULT_SCOPE, scope, depositNonce) — unsalt stem.
  const labelStem = await poseidon3(
    DOMAIN_VAULT_SCOPE,
    scope,
    BigInt(profile.depositNonce),
  );
  assert.equal(labelStem.toString(), profile.label, "label stem != chain-profile-solana.json");

  const payeeField = await poseidon2(
    DOMAIN_PAYEE_SOL_COMPRESS,
    BigInt("0x" + profile.payeePubkeyBytes32),
  );
  assert.equal(payeeField.toString(), profile.payeeField, "payeeField != chain-profile-solana.json");

  const payeeId = await payeeIdSolana(payee);
  assert.equal(payeeId.toString(), profile.payeeId, "payeeIdSolana != chain-profile-solana.json");

  console.log("noteCryptoSolana.check: PASS (vector parity with chain-profile-solana.json)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

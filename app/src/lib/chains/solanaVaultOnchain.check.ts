//   npx tsx src/lib/chains/solanaVaultOnchain.check.ts
import assert from "node:assert";
import { PublicKey } from "@solana/web3.js";
import {
  SIPHON_VAULT_PROGRAM_ID,
  commitmentHash,
  notePda,
  vaultPda,
  compliancePda,
} from "./solanaVaultOnchain";

assert.equal(
  SIPHON_VAULT_PROGRAM_ID.toBase58(),
  "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj",
);

const [vault] = vaultPda();
const [compliance] = compliancePda();
assert.ok(vault.toBase58().length >= 32);
assert.ok(compliance.toBase58().length >= 32);
assert.notEqual(vault.toBase58(), compliance.toBase58());

const salt = new Uint8Array(32).fill(2);
const pre = new Uint8Array(32).fill(3);
const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

async function main() {
  const c1 = await commitmentHash({ amount: 1_000_000n, mint, userSalt: salt, precommitment: pre });
  const c2 = await commitmentHash({ amount: 1_000_000n, mint, userSalt: salt, precommitment: pre });
  assert.deepEqual(Buffer.from(c1), Buffer.from(c2));
  const [note] = notePda(c1);
  assert.ok(note.toBase58());
  console.log("solanaVaultOnchain.check: PASS", {
    vault: vault.toBase58(),
    compliance: compliance.toBase58(),
    note: note.toBase58(),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

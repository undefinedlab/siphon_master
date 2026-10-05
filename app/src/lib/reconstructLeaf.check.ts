/**
 * Self-check: Hard ASP reconstructLeaf (amount, label, precommitment nesting).
 * Run: npx tsx src/lib/reconstructLeaf.check.ts
 */
import { strict as assert } from 'assert';
import { generateCommitmentData, reconstructLeaf } from './zkHandler';
import { hashCommitment, hashLabel, hashPrecommitment } from './noteCrypto';

async function main() {
  // @ts-expect-error — args are unused placeholders in generateCommitmentData
  const c = await generateCommitmentData(11155111, { symbol: 'ETH' }, '0.005');
  const amountWei = 5_000_000_000_000_000n; // 0.005 ETH
  const scope = 0xabcdefn;
  const nonce = 1n;
  const label = await hashLabel(scope, nonce);
  const r = await reconstructLeaf(BigInt(c.nullifier), BigInt(c.secret), amountWei, label);

  assert.equal(r.precommitment.toString(), c.precommitment, 'precommitment mismatch');
  assert.equal(r.nullifierHash.toString(), c.nullifierHash, 'nullifierHash mismatch');
  const expectedLeaf = await hashCommitment(amountWei, label, await hashPrecommitment(BigInt(c.nullifier), BigInt(c.secret)));
  assert.equal(r.leaf.toString(), expectedLeaf.toString(), 'leaf mismatch');
  console.log('✓ Hard ASP reconstructLeaf OK');
}

main().catch((e) => { console.error(e); process.exit(1); });

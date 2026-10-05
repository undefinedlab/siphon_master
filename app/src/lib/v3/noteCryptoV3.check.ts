// Runnable self-check for the v3 (D1) note hashing — no test framework in this repo.
//   npx tsx src/lib/v3/noteCryptoV3.check.ts
//
// Verifies noteCryptoV3 against the SHARED fixtures in siphon-zk-v2/test-vectors/, which are the
// executable contract between this client, spend-core (Rust), and the Circom circuits. If this
// file passes, the app derives byte-identical labels and commitments to the prover and the chain.
//
// This is the guard that catches the expensive class of mistake: a commitment that hashes fine,
// stores fine, and is simply never in the tree.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOMAIN_CHAIN_EVM,
  DOMAIN_VAULT_SCOPE,
  assetIdFromToken,
  deriveDepositLabel,
  hashCommitment,
  hashPrecommitment,
  mintLabelSalted,
  modField,
  randomUserSalt,
  vaultScopeId,
} from "./noteCryptoV3";

const VECTORS = join(__dirname, "..", "..", "..", "..", "siphon-zk-v2", "test-vectors");
const load = (f: string) => JSON.parse(readFileSync(join(VECTORS, f), "utf8"));

async function main() {
  // ---- domains match the shared constants -------------------------------------------------
  const domains = load("domains.json");
  assert.equal(
    DOMAIN_VAULT_SCOPE.toString(),
    domains.DOMAIN_VAULT_SCOPE,
    "DOMAIN_VAULT_SCOPE drifted from test-vectors/domains.json",
  );
  assert.equal(
    DOMAIN_CHAIN_EVM.toString(),
    domains.DOMAIN_CHAIN_EVM,
    "DOMAIN_CHAIN_EVM drifted from test-vectors/domains.json",
  );

  // ---- vaultScopeId + label vs the evm-v1 chain profile ------------------------------------
  const profile = load("chain-profile-evm.json");
  const scope = await vaultScopeId(profile.chainId, profile.vaultAddress);
  assert.equal(
    scope.toString(),
    profile.vaultScopeId,
    "vaultScopeId != chain-profile-evm.json — Poseidon(DOMAIN_CHAIN_EVM, chainId, uint160(vault)) is wrong",
  );

  // ---- deposit-ok: salted label + D1 commitment --------------------------------------------
  const dep = load("deposit-ok.json");
  assert.equal(
    dep.vaultScopeId,
    profile.vaultScopeId,
    "fixture drift: deposit-ok and chain-profile disagree on vaultScopeId",
  );

  const label = await mintLabelSalted(
    BigInt(dep.vaultScopeId),
    dep.depositNonce,
    BigInt(dep.userSalt),
  );
  assert.equal(
    label.toString(),
    dep.expectedLabel,
    "salted label != deposit-ok.json expectedLabel",
  );

  // Same label via the convenience wrapper (chain + vault address rather than a precomputed scope).
  const label2 = await deriveDepositLabel({
    chainId: dep.chainId,
    vaultAddress: profile.vaultAddress,
    depositNonce: dep.depositNonce,
    userSalt: BigInt(dep.userSalt),
  });
  assert.equal(label2.toString(), dep.expectedLabel, "deriveDepositLabel disagrees with mintLabelSalted");

  const commitment = await hashCommitment(
    BigInt(dep.measuredAmount),
    label,
    BigInt(dep.assetId),
    BigInt(dep.nullifier),
    BigInt(dep.secret),
  );
  assert.equal(
    commitment.toString(),
    dep.expectedCommitment,
    "D1 commitment != deposit-ok.json — inner hash must be 3-input Poseidon(amount,label,assetId)",
  );

  // ---- the v2 shape must NOT reproduce the v3 commitment -----------------------------------
  // Guards against silently "fixing" hashCommitment back to nested 2-input hashing.
  const { poseidon2, poseidon3 } = await import("./noteCryptoV3");
  const v2Inner = await poseidon2(BigInt(dep.measuredAmount), label);
  const pre = await hashPrecommitment(BigInt(dep.nullifier), BigInt(dep.secret));
  const v2Style = await poseidon2(v2Inner, pre);
  assert.notEqual(
    v2Style.toString(),
    dep.expectedCommitment,
    "v2 nested-hash form matched the v3 fixture — impossible; the check is not testing what it claims",
  );
  const v3Inner = await poseidon3(BigInt(dep.measuredAmount), label, BigInt(dep.assetId));
  assert.notEqual(
    v3Inner.toString(),
    v2Inner.toString(),
    "poseidon3 collapsed to poseidon2 — wrong Poseidon instance",
  );

  // ---- zero-salt is refused (PROTOCOL §2.3 / O-24) ------------------------------------------
  const zeroSalt = load("deposit-zero-salt-fail.json");
  assert.equal(String(zeroSalt.userSalt), "0", "fixture drift: deposit-zero-salt-fail should carry userSalt 0");
  await assert.rejects(
    () => mintLabelSalted(BigInt(dep.vaultScopeId), dep.depositNonce, 0n),
    /non-zero/,
    "zero userSalt must be refused",
  );
  // FIELD is congruent to 0 — must be refused too, not silently accepted.
  const { FIELD } = await import("./noteCryptoV3");
  await assert.rejects(
    () => mintLabelSalted(BigInt(dep.vaultScopeId), dep.depositNonce, FIELD),
    /non-zero/,
    "userSalt == FIELD (== 0 mod p) must be refused",
  );

  // ---- assetId encoding ---------------------------------------------------------------------
  assert.equal(
    assetIdFromToken("0x00000000000000000000000000000000000000A1").toString(),
    "161",
    "assetIdFromToken must be uint160(token) and case-insensitive",
  );
  assert.throws(() => assetIdFromToken("0xdeadbeef"), /20-byte/, "short address must throw");
  assert.throws(() => assetIdFromToken(""), /20-byte/, "empty address must throw");

  // ---- native ETH resolves to WETH ------------------------------------------------------------
  // Deposit wraps ETH, so the note binds WETH. Any consumer deriving an assetId from a *displayed*
  // token must apply the same substitution — deposit and balance disagreeing here means the funds
  // land on-chain and then read as zero, which is silent and looks like a lost deposit.
  {
    const { noteAssetAddress } = await import("./noteCryptoV3");
    const { NATIVE_TOKEN, getNetwork } = await import("../networks");
    const SEPOLIA = 11155111;
    const weth = getNetwork(SEPOLIA).weth;

    assert.equal(
      noteAssetAddress(SEPOLIA, NATIVE_TOKEN).toLowerCase(),
      weth.toLowerCase(),
      "native ETH must resolve to the chain's WETH",
    );
    assert.equal(
      noteAssetAddress(SEPOLIA, "0x0000000000000000000000000000000000000000").toLowerCase(),
      weth.toLowerCase(),
      "zero address must resolve to WETH too",
    );
    assert.equal(
      assetIdFromToken(noteAssetAddress(SEPOLIA, NATIVE_TOKEN)),
      assetIdFromToken(weth),
      "ETH and WETH must produce ONE assetId, or a wrapped deposit is invisible to the balance",
    );

    // noteAssetIdFor is the composition every display-facing call site must use. Deriving straight
    // from the sentinel is what made withdraw report "no spendable notes" for funds in the pool.
    const { noteAssetIdFor } = await import("./noteCryptoV3");
    assert.equal(
      noteAssetIdFor(SEPOLIA, NATIVE_TOKEN),
      assetIdFromToken(weth),
      "noteAssetIdFor(ETH) must equal uint160(WETH), not uint160(0xEeee…)",
    );
    assert.notEqual(
      noteAssetIdFor(SEPOLIA, NATIVE_TOKEN),
      assetIdFromToken(NATIVE_TOKEN),
      "the sentinel's own assetId must never be what a note carries",
    );

    const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    assert.equal(
      noteAssetAddress(SEPOLIA, usdc),
      usdc,
      "a real ERC-20 must pass through untouched",
    );
  }

  // ---- salt generator ------------------------------------------------------------------------
  for (let i = 0; i < 32; i++) {
    const s = randomUserSalt();
    assert.ok(s > 0n && s < FIELD, "randomUserSalt out of range");
    assert.equal(modField(s), s, "randomUserSalt not already reduced");
  }

  console.log("noteCryptoV3.check: OK — matches siphon-zk-v2/test-vectors (label, scope, D1 commitment)");
}

main().catch((e) => {
  console.error("noteCryptoV3.check FAILED:", e.message);
  process.exit(1);
});

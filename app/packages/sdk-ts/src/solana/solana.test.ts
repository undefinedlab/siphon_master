import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { flattenProof } from "../v5/prover";
import { hashCommitmentWithPre, hashPrecommitment, mintLabelSalted } from "../v5/noteCrypto";
import { COMPLIANCE_PDA, TREE_PDA, VAULT_PDA, WSOL_MINT, assetIdOf, fieldOfKey } from "./constants";
import { expectedDepositInstructions, verifyDepositTransaction } from "./deposit";
import { noteFromReturn, prepareSolanaDeposit, solanaVaultScope } from "./notes";
import { proofHex } from "./prove";

// Read from the live vault account on 2026-10-10 (GET /v1/chains/900002/vault → scope_id).
const ONCHAIN_SCOPE = 17356072462872782250475917647802616354164571014121831419134905260326911132729n;
const wallet = Keypair.generate().publicKey;

describe("Solana Devnet pins", () => {
  test("PDAs match the deployment record", () => {
    expect(VAULT_PDA.toBase58()).toBe("9ndUc4FN7djmULrsJxKiVhcaxfQciXBRQcFJc9rWQb9G");
    expect(TREE_PDA.toBase58()).toBe("7c6F4mNgQRSNmit6feAgJLx1HFojNQTnEDiSoc2dEoxn");
    expect(COMPLIANCE_PDA.toBase58()).toBe("42r85DiU5wV1PM2oYy9gt85Z6S8fcihYp1bWvL3xH4cT");
  });

  test("the vault scope derived from the pinned program equals the on-chain one", async () => {
    expect(await solanaVaultScope()).toBe(ONCHAIN_SCOPE);
  });

  test("a deposit refuses a vault whose scope differs from the pinned one", async () => {
    await expect(prepareSolanaDeposit({ asset: "SOL", amount: 1n, depositNonce: 0, scopeId: ONCHAIN_SCOPE + 1n })).rejects.toThrow("scope_id");
  });
});

describe("deposit transaction", () => {
  const build = async (mutate?: (tx: Transaction) => void) => {
    const d = await prepareSolanaDeposit({ asset: "SOL", amount: 10_000_000n, depositNonce: 3, scopeId: ONCHAIN_SCOPE });
    const tx = new Transaction({ feePayer: wallet, recentBlockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM" });
    tx.add(...(await expectedDepositInstructions(wallet, d)));
    mutate?.(tx);
    return { d, b64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
  };

  test("commitment is the program's: P2(P3(amount, label, mint), P2(nf, secret))", async () => {
    const { d } = await build();
    const label = await mintLabelSalted(ONCHAIN_SCOPE, 3n, BigInt(d.userSalt));
    const pre = await hashPrecommitment(BigInt(d.nullifier), BigInt(d.secret));
    expect(BigInt(d.commitment)).toBe(await hashCommitmentWithPre(10_000_000n, label, fieldOfKey(WSOL_MINT), pre));
    expect(d.label).toBe(label.toString());
  });

  test("accepts exactly the locally built transaction", async () => {
    const { d, b64 } = await build();
    expect((await verifyDepositTransaction(b64, wallet, d)).instructions).toHaveLength(4); // wrap ×3 + deposit
  });

  test("refuses another commitment, another fee payer, or an extra instruction", async () => {
    const { d, b64 } = await build();
    const other = await prepareSolanaDeposit({ asset: "SOL", amount: 10_000_000n, depositNonce: 3, scopeId: ONCHAIN_SCOPE });
    await expect(verifyDepositTransaction(b64, wallet, other)).rejects.toThrow("differs");
    await expect(verifyDepositTransaction(b64, Keypair.generate().publicKey, d)).rejects.toThrow("fee payer");
    const { b64: extra } = await build((tx) => tx.add(...tx.instructions.slice(1, 2)));
    await expect(verifyDepositTransaction(extra, wallet, d)).rejects.toThrow("unexpected instructions");
  });
});

test("proof hex is A | B (c1‖c0) | C, 32-byte big-endian each", () => {
  const p = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };
  const hex = proofHex(flattenProof(p));
  expect(hex.length).toBe(512);
  const words = hex.match(/.{64}/g)!.map((w) => BigInt(`0x${w}`));
  expect(words).toEqual([1n, 2n, 4n, 3n, 6n, 5n, 7n, 8n]);
});

test("a returned note opens only with the secrets kept at arm time", async () => {
  const [nf, sec, salt] = [11n, 22n, 33n];
  const label = await mintLabelSalted(ONCHAIN_SCOPE, 9n, salt);
  const commitment = await hashCommitmentWithPre(1_319_409n, label, assetIdOf("USDC"), await hashPrecommitment(nf, sec));
  const returned = { commitment: commitment.toString(), deposit_nonce: "9", amount: "1319409", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };
  const note = await noteFromReturn({ returned, nullifier: "11", secret: "22", userSalt: "33" });
  expect(note.label).toBe(label.toString());
  await expect(noteFromReturn({ returned, nullifier: "11", secret: "23", userSalt: "33" })).rejects.toThrow("does not open");
  expect(new PublicKey(note.token).equals(new PublicKey(returned.mint))).toBe(true);
});

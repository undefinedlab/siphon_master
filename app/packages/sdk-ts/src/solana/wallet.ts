/**
 * A Solana wallet as the SDK needs it: sign messages (API intents, the FHE key seed) and
 * transactions (deposits). `keypairWallet` covers servers and scripts; a browser passes Phantom.
 */
import { createPrivateKey, sign } from "node:crypto";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { WalletSigner } from "../v5/api";

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SolanaWallet {
  publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

/** Node only (uses node:crypto). A browser passes its wallet adapter instead. */
export function keypairWallet(kp: Keypair): SolanaWallet {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(kp.secretKey.slice(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return {
    publicKey: kp.publicKey,
    signMessage: async (message) => new Uint8Array(sign(null, message, key)),
    signTransaction: async (tx) => {
      tx.partialSign(kp);
      return tx;
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * The SiphonApi signer for a Solana wallet: the gateway verifies the same intent text with ed25519
 * and takes the signature base64. The address is base58, case and all.
 */
export function solanaApiSigner(wallet: SolanaWallet): WalletSigner {
  return {
    getAddress: async () => wallet.publicKey.toBase58(),
    signMessage: async (message: string) => toBase64(await wallet.signMessage(new TextEncoder().encode(message))),
  };
}

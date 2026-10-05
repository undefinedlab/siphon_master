/**
 * Client-side FHE for Devnet orders: order bounds are encrypted HERE, so the executor and engine only
 * ever see ciphertext. Same wasm as the dapp (siphon-app fhe-wasm, tfhe byte-compatible with the
 * engine), vendored under vendor/fhe-wasm. Node only.
 *
 * The client key is DERIVED from one wallet signature over the dapp's exact seed message, so a wallet
 * gets the same key in the dapp and the SDK — orders armed in one stay readable by the decryptor
 * key the other uploaded.
 */
import { keccak256 } from "ethers";
import type { SolanaWallet } from "./wallet";

/** Byte-identical to siphon-app src/lib/fhe.ts KEY_SEED_MESSAGE. Changing it changes every key. */
export const KEY_SEED_MESSAGE =
  "Siphon Protocol\n\nSign to derive your private FHE encryption key.\n\n" +
  "This signature deterministically recreates the SAME key on every device and never leaves your " +
  "browser. Only sign this on the official Siphon app.";

type FheModule = {
  generate_keys_from_seed(seedHex: string): string;
  derive_server_key(clientKeyHex: string): string;
  encrypt_price(priceCents: bigint, clientKeyHex: string): string;
  decrypt_result(ciphertextHex: string, clientKeyHex: string): boolean;
};

let loaded: Promise<FheModule> | null = null;

export function loadFhe(): Promise<FheModule> {
  loaded ??= (async () => {
    const { readFile } = await import("node:fs/promises");
    const dir = new URL("../../vendor/fhe-wasm/", import.meta.url);
    const glue = (await import(new URL("siphon_fhe_wasm_bg.js", dir).href)) as FheModule & {
      __wbg_set_wasm(exports: WebAssembly.Exports): void;
    };
    const { instance } = await WebAssembly.instantiate(await readFile(new URL("siphon_fhe_wasm_bg.wasm", dir)), {
      "./siphon_fhe_wasm_bg.js": glue as unknown as WebAssembly.ModuleImports,
    });
    glue.__wbg_set_wasm(instance.exports);
    (instance.exports.__wbindgen_start as (() => void) | undefined)?.();
    return glue;
  })();
  return loaded;
}

/** The wallet's FHE client key (hex). Deterministic: one signature, same key every time. */
export async function deriveClientKey(wallet: SolanaWallet): Promise<string> {
  const sig = await wallet.signMessage(new TextEncoder().encode(KEY_SEED_MESSAGE));
  const seed = keccak256(sig); // the dapp hashes the same 64 signature bytes
  return (await loadFhe()).generate_keys_from_seed(seed);
}

/** Heavy (seconds, ~23 MB hex): the engine's evaluation key for this client key. */
export async function deriveServerKey(clientKey: string): Promise<string> {
  return (await loadFhe()).derive_server_key(clientKey);
}

/** A price in dollars, encrypted as cents — what the engine compares against. */
export async function encryptPrice(price: number, clientKey: string): Promise<string> {
  if (!Number.isFinite(price) || price < 0) throw new Error(`encryptPrice: invalid price ${price}`);
  return (await loadFhe()).encrypt_price(BigInt(Math.round(price * 100)), clientKey);
}

export async function encryptCents(cents: bigint, clientKey: string): Promise<string> {
  return (await loadFhe()).encrypt_price(cents, clientKey);
}

/** encrypt(0): the canary the executor's self-check decrypts to prove the key generations match. */
export async function canary(clientKey: string): Promise<string> {
  return encryptCents(0n, clientKey);
}

export type ConditionNode =
  | { op: "LEAF"; asset?: string; price_feed_id?: string; comparator?: string; bound: number | string; [k: string]: unknown }
  | { op: string; conditions: ConditionNode[]; [k: string]: unknown };

/** Every LEAF's plaintext `bound` becomes `encrypted_bound`; nothing plaintext leaves the process. */
export async function encryptConditionTree(tree: ConditionNode, clientKey: string): Promise<unknown> {
  if (tree.op === "LEAF") {
    const { bound, ...rest } = tree as { bound: number | string };
    const n = typeof bound === "string" ? Number(bound.trim() || NaN) : bound;
    if (!Number.isFinite(n)) throw new Error("encryptConditionTree: every LEAF needs a numeric bound");
    return { ...rest, encrypted_bound: await encryptPrice(n, clientKey) };
  }
  const node = tree as { conditions: ConditionNode[] };
  return { ...tree, conditions: await Promise.all(node.conditions.map((c) => encryptConditionTree(c, clientKey))) };
}

export interface DecryptorAttestation {
  x25519_pubkey: string;
  report_data_hex: string;
  quote: string | null;
  mock_kms?: boolean;
}

/**
 * Seal the client key to the decryptor's attested x25519 key. The decryptor decrypts only trigger
 * bits with it. Devnet runs a MOCK attester (no TDX): sealing then protects the key in transit only,
 * so it is accepted only when the caller opts in with `allowMockTee`.
 */
export async function sealClientKey(clientKey: string, att: DecryptorAttestation, opts: { allowMockTee?: boolean } = {}): Promise<string> {
  const pubkey = (att.x25519_pubkey || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("attestation is missing the decryptor's x25519 key");
  if (att.quote) {
    throw new Error("TDX quote verification is not in the SDK yet; seal through the dapp, or verify the quote yourself");
  }
  if (!att.mock_kms || !opts.allowMockTee) {
    throw new Error("the decryptor is a mock (no TDX quote); pass allowMockTee: true to accept it on Devnet");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`siphon-decryptor:${pubkey}`)));
  if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== (att.report_data_hex || "").toLowerCase()) {
    throw new Error("mock decryptor report_data does not bind its x25519 key");
  }
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;
  return sodium.to_hex(sodium.crypto_box_seal(sodium.from_hex(clientKey), sodium.from_hex(pubkey)));
}

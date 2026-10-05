/**
 * Local Groth16 proving for v5 spends. Secrets never leave the process: the SDK downloads the
 * PUBLIC circuit artifacts and proves here, exactly as the dapp does in the browser.
 *
 * Mirrors siphon-app src/lib/v3/withdrawV3.ts + complianceProofV3.ts::proveComplianceV3, minus the
 * browser Cache Storage and the optional enclave prover.
 */
import * as snarkjs from "snarkjs";
import { chainConfig, DEFAULT_ZK_BASE_URL } from "./constants";
import { COMPLIANCE_PUBLIC_WIDTH, compliancePublics, labelCommit, MAX_INPUTS, type ComplianceHalf } from "./labelCommit";
import { modField } from "./noteCrypto";
import type { ComplianceWitness } from "./types";
import { ZK_PINS } from "./zkPins";

export interface ProverOptions {
  /** Origin serving the contents of the dapp's `public/zk`. Default: Siphon's public bucket. */
  zkBaseUrl?: string;
  /**
   * Node only: cache artifacts here. withdraw6's zkey is ~144 MB, so without a cache every proof of
   * that arity re-downloads it.
   */
  cacheDir?: string;
  /** Override the transport entirely (tests, bundled artifacts). Still hash-checked. */
  load?: (path: string) => Promise<Uint8Array>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Flat row-major 8 with the G2 coordinates swapped — the layout VaultKernel's verifiers take. */
export type FlatProof = string[];

type SnarkProof = { pi_a: string[]; pi_b: string[][]; pi_c: string[] };

export function flattenProof(p: SnarkProof): FlatProof {
  const s = (v: string) => BigInt(v).toString();
  return [
    s(p.pi_a[0]), s(p.pi_a[1]),
    s(p.pi_b[0][1]), s(p.pi_b[0][0]),
    s(p.pi_b[1][1]), s(p.pi_b[1][0]),
    s(p.pi_c[0]), s(p.pi_c[1]),
  ];
}

export class Prover {
  private readonly base: string;
  constructor(private readonly opts: ProverOptions = {}) {
    this.base = (opts.zkBaseUrl || DEFAULT_ZK_BASE_URL).replace(/\/+$/, "");
  }

  /**
   * Every artifact must hash to its release pin, whether it came from the network, the cache or a
   * caller's loader. Unknown paths are refused: an unpinned artifact is an unreviewed one.
   */
  private async load(path: string): Promise<Uint8Array> {
    const pin = ZK_PINS[path];
    if (!pin) throw new Error(`zk artifact ${path} has no release pin — refusing to use it`);
    const check = async (bytes: Uint8Array, from: string) => {
      const got = await sha256Hex(bytes);
      if (got !== pin) throw new Error(`zk artifact ${path} from ${from} has sha256 ${got}, pinned ${pin} — refusing to prove with it`);
      return bytes;
    };
    if (this.opts.load) return check(await this.opts.load(path), "the custom loader");
    // SIPHON_ZK_CACHE_DIR: the default for every Prover the SDK builds internally (orders, splits),
    // which take no options — the MCP server sets it so a 144 MB zkey downloads once, not per proof.
    const dir = this.opts.cacheDir ?? (typeof process !== "undefined" ? process.env.SIPHON_ZK_CACHE_DIR : undefined);
    if (!dir) return check(await this.fetchBytes(path), this.base);
    const fs = await import("node:fs/promises");
    // Content-addressed: a cache entry is its own integrity check, and a rotated artifact is a
    // different file rather than a stale hit.
    const file = `${dir}/${pin}`;
    try {
      const cached = new Uint8Array(await fs.readFile(file));
      if ((await sha256Hex(cached)) === pin) return cached;
    } catch {
      /* miss */
    }
    const bytes = await check(await this.fetchBytes(path), this.base);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file); // atomic; concurrent writers race to identical content
    return bytes;
  }

  private async fetchBytes(path: string): Promise<Uint8Array> {
    const res = await fetch(`${this.base}/${path}`);
    if (!res.ok) throw new Error(`zk artifact ${path}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Per-chain key set: the wasm is shared, the zkey + vkey carry the ceremony delta. */
  private keyDir(chainId: number, circuit: string): string {
    // Solana Devnet (900002) has no EVM chain entry; its program's VK accounts hold the dev-beacon set.
    const keys = chainId === 900002 ? "dev" : chainConfig(chainId).zkKeys;
    return keys === "ceremony" ? `ceremony/${circuit}` : circuit;
  }

  /**
   * Prove `circuit` over `input`, then fail closed unless the proof's publics equal `expected`
   * and it verifies against the chain's vkey. Returns the flat on-chain proof.
   */
  async prove(chainId: number, circuit: string, input: object, expected: string[]): Promise<FlatProof> {
    const keys = this.keyDir(chainId, circuit);
    const [wasm, zkey, vkeyBytes] = await Promise.all([
      this.load(`${circuit}/main_${circuit}.wasm`),
      this.load(`${keys}/zkey_final.zkey`),
      this.load(`${keys}/verification_key.json`),
    ]);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input as never, wasm, zkey);
    const got = (publicSignals as string[]).map((v) => BigInt(v).toString());
    if (got.length !== expected.length) {
      throw new Error(`${circuit}: ${got.length} publics, expected ${expected.length}`);
    }
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== BigInt(expected[i]).toString()) {
        throw new Error(`${circuit}: public limb ${i} is ${got[i]}, expected ${expected[i]}`);
      }
    }
    const vkey = JSON.parse(new TextDecoder().decode(vkeyBytes));
    if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) {
      throw new Error(`${circuit}: local verify failed`);
    }
    return flattenProof(proof as unknown as SnarkProof);
  }

  /**
   * The COMPLIANCE half over the same labels and salt as the spend. Exact arity: a 2-note spend
   * uses `compliance2`.
   */
  async proveCompliance(args: {
    chainId: number;
    labels: bigint[];
    compliance: ComplianceWitness;
    salt: bigint;
    /** Spend limb 24 — a drift here would revert ComplianceProofFailed() after gas is spent. */
    expectedCommit: bigint;
  }): Promise<ComplianceHalf> {
    const n = args.labels.length;
    if (n < 1 || n > MAX_INPUTS) throw new Error(`proveCompliance: invalid arity ${n}`);
    const slots = args.compliance.inputs.slice(0, n);
    if (slots.length !== n) throw new Error(`proveCompliance: ASP returned ${slots.length} inputs, need ${n}`);
    slots.forEach((c, i) => {
      if (BigInt(c.inLabel) !== args.labels[i]) throw new Error(`proveCompliance: ASP label mismatch at ${i}`);
    });
    const commit = await labelCommit(n, args.labels, args.salt);
    if (commit !== modField(args.expectedCommit)) {
      throw new Error("proveCompliance: labelCommit drift between the spend and compliance halves");
    }
    const publicInputs = compliancePublics(
      n,
      BigInt(args.compliance.admittedRoot),
      BigInt(args.compliance.revokedRoot),
      commit,
    );
    const input = {
      publicInputs,
      salt: args.salt.toString(),
      inLabel: args.labels.map(String),
      admittedLeafIndex: slots.map((c) => String(c.admittedLeafIndex)),
      admittedPathElements: slots.map((c) => c.admittedPathElements),
      admittedPathIndices: slots.map((c) => c.admittedPathIndices),
      revokedSmtPathElements: slots.map((c) => c.revokedSmtPathElements),
      revokedSmtPathIndices: slots.map((c) => c.revokedSmtPathIndices),
      revokedSmtLeaf: slots.map((c) => String(c.revokedSmtLeaf)),
    };
    const proof = await this.prove(args.chainId, `compliance${n}`, input, publicInputs);
    if (publicInputs.length !== COMPLIANCE_PUBLIC_WIDTH) throw new Error("proveCompliance: bad width");
    return { publicInputs, proof };
  }
}

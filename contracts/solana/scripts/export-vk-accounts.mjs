/**
 * Convert snarkjs verification_key.json → packed Solana VK account bytes
 * (layout matches siphon-vault::verify::vk_account).
 *
 * Usage:
 *   node scripts/export-vk-accounts.mjs
 *   node scripts/export-vk-accounts.mjs --src ../siphon-app/public/zk/ceremony --out target/deploy/vk
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, "../..");

const CIRCUITS = [
  "withdraw1",
  "withdraw2",
  "withdraw3",
  "withdraw4",
  "withdraw5",
  "withdraw6",
  "merge2",
  "merge3",
  "merge4",
  "merge5",
  "merge6",
  "swap",
  "split",
  "ragequit",
];

const NR_PUBLIC = 25;
const VK_IC_LEN = NR_PUBLIC + 1;
const VK_ACCOUNT_BYTES = 8 + 64 + 128 + 128 + 128 + VK_IC_LEN * 64;

// BN254 field modulus
const P = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

function parseArgs(argv) {
  let src = path.join(REPO, "siphon-app", "public", "zk", "ceremony");
  let out = path.join(ROOT, "target", "deploy", "vk");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") src = path.resolve(argv[++i]);
    if (argv[i] === "--out") out = path.resolve(argv[++i]);
  }
  return { src, out };
}

function toBe32(n) {
  let x = BigInt(n) % P;
  if (x < 0n) x += P;
  const hex = x.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function g1ToBytes(pt) {
  // snarkjs: [x, y, 1]
  const out = Buffer.alloc(64);
  toBe32(pt[0]).copy(out, 0);
  toBe32(pt[1]).copy(out, 32);
  return out;
}

function g2ToBytes(pt) {
  // snarkjs G2: [[x_c0, x_c1], [y_c0, y_c1], [1, 0]].
  // groth16-solana / Light expect each Fp2 as c1 || c0 (big-endian limbs).
  const out = Buffer.alloc(128);
  toBe32(pt[0][1]).copy(out, 0); // x.c1
  toBe32(pt[0][0]).copy(out, 32); // x.c0
  toBe32(pt[1][1]).copy(out, 64); // y.c1
  toBe32(pt[1][0]).copy(out, 96); // y.c0
  return out;
}

function packVk(vkJson) {
  if (Number(vkJson.nPublic) !== NR_PUBLIC) {
    throw new Error(`expected nPublic=${NR_PUBLIC}, got ${vkJson.nPublic}`);
  }
  const alpha = g1ToBytes(vkJson.vk_alpha_1);
  const beta = g2ToBytes(vkJson.vk_beta_2);
  const gamma = g2ToBytes(vkJson.vk_gamma_2);
  const delta = g2ToBytes(vkJson.vk_delta_2);
  const ic = (vkJson.IC || vkJson.vk_ic || []).map(g1ToBytes);
  if (ic.length !== VK_IC_LEN) {
    throw new Error(`expected IC length ${VK_IC_LEN}, got ${ic.length}`);
  }

  const raw = Buffer.alloc(VK_ACCOUNT_BYTES);
  raw.writeBigUInt64LE(BigInt(NR_PUBLIC), 0);
  alpha.copy(raw, 8);
  beta.copy(raw, 72);
  gamma.copy(raw, 200);
  delta.copy(raw, 328);
  for (let i = 0; i < VK_IC_LEN; i++) {
    ic[i].copy(raw, 456 + i * 64);
  }
  return raw;
}

function main() {
  const { src, out } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(out, { recursive: true });
  const registry = {};

  for (const name of CIRCUITS) {
    const vkPath = path.join(src, name, "verification_key.json");
    if (!fs.existsSync(vkPath)) {
      console.warn(`SKIP missing ${vkPath}`);
      continue;
    }
    const vkJson = JSON.parse(fs.readFileSync(vkPath, "utf8"));
    const blob = packVk(vkJson);
    const binPath = path.join(out, `${name}.vk.bin`);
    fs.writeFileSync(binPath, blob);
    const sha = createHash("sha256").update(blob).digest("hex");
    registry[name] = {
      file: path.relative(ROOT, binPath).replace(/\\/g, "/"),
      bytes: blob.length,
      sha256: sha,
    };
    console.log(`OK ${name} → ${binPath} (${blob.length} B)`);
  }

  const regPath = path.join(out, "registry.json");
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2));
  console.log(`Wrote ${regPath}`);
}

main();

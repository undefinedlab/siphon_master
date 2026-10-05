/**
 * Builder chat must not surface internal arm-gate diagnostics
 * (vault-index / trade-executor / anonymity-set fail-closed copy).
 */

const EXCISE = [
  /\s*\(?\s*blocked by live graph context\s*:[\s\S]*?(?:reachable\.?\s*\)?|(?=\n\n)|$)/gi,
  /\s*i won'?t arm that yet\s*[—–-]\s*live graph context\s*:[\s\S]*?(?:reachable\.?|(?=\n\n)|$)/gi,
  /\s*block:\s*no anonymity-set data[\s\S]*?(?:reachable\.?|(?=\n\n)|$)/gi,
  /\s*no anonymity-set data\s*\([^)]*\)\.?/gi,
  /\s*ensure trade-executor\s*\/\s*vault-index is reachable\.?/gi,
];

const INTERNAL_ARM_RE =
  /blocked by live graph|live graph context|anonymity-set|anonymity set data|trade-executor|trade executor|vault-index|fail-closed|won'?t arm that yet/i;

export function stripInternalArmCopy(message: string): string {
  let out = message;
  for (const re of EXCISE) out = out.replace(re, "");

  const kept = out
    .split(/\n+/)
    .map((para) =>
      para
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !INTERNAL_ARM_RE.test(sentence))
        .join(" ")
        .replace(/\(\s*\)/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim(),
    )
    .filter(Boolean);

  return kept.join("\n\n").trim();
}

// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();
import { zkUrl } from "./zkAssets";
import { Contract, JsonRpcProvider, ethers, type Signer, type TransactionReceipt } from "ethers";
import {
  buildLegacyW1CircuitInput,
  classifyLegacyCommitments,
  receivedNativeAmount,
  runConfirmedMigrationStep,
  withTransientReadRetry,
  type LegacyCommitmentCandidate,
} from "./legacyMigrationCore";
import { fetchCommitments, markCommitmentSpent } from "./commitmentStore";
import { deposit } from "./handler";
import { getNetwork, getReadProviderRpcUrl, getTokens, NATIVE_TOKEN } from "./networks";
import { markNoteSpentTyped } from "./localNoteStore";

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TREE_DEPTH = 32;
const LEGACY_ENTRYPOINT_ABI = [
  "function getVault(address asset) view returns (address)",
  "function withdraw(address asset,address recipient,uint256 withdrawnValue,uint256 stateRoot,uint256[] nullifierHashes,uint256 changeCommitment,uint256[2] pA,uint256[2][2] pB,uint256[2] pC)",
];
const LEGACY_VAULT_ABI = [
  "function merkleTree() view returns (address)",
  "function nullifiers(uint256) view returns (bool)",
];
const MERKLE_TREE_READ_ABI = [
  "function getRoot() view returns (uint256)",
  "function getSize() view returns (uint256)",
];
const DEFAULT_LEGACY_INDEX_URL = "https://54-81-171-22.sslip.io/vault-index";

export interface LegacyVaultGeneration {
  chainId: number;
  generationId: string;
  entrypoint: string;
  deployBlock: number;
}

export const LEGACY_VAULTS: Partial<Record<number, LegacyVaultGeneration>> = {
  8453: {
    chainId: 8453,
    generationId: "base-soft-era",
    entrypoint: "0x5433995fc5a0459E5ad7f2A81561384887F37174",
    deployBlock: 48703314,
  },
  11155111: {
    chainId: 11155111,
    generationId: "sepolia-soft-era",
    entrypoint: "0xE5126A49D1bb93957b4B2F63BCB05a1F8EA9e705",
    deployBlock: 11278082,
  },
};

export interface LegacyMigrationNote extends LegacyCommitmentCandidate {
  asset: "ETH" | "USDC";
}

export interface LegacyMigrationSummary {
  notes: LegacyMigrationNote[];
  totals: Record<string, number>;
}

export interface LegacyMigrationResult {
  migrated: Array<{ asset: string; amount: string; withdrawTx: string; depositTx: string }>;
  pendingAdmission: Array<{
    asset: string;
    amount: string;
    withdrawTx: string;
    depositTx: string;
    error: string;
  }>;
  walletOnly: Array<{ asset: string; amount: string; withdrawTx: string; error: string }>;
  /** Notes that never left the old vault. Nothing moved on-chain for these, so they are safe
   * to retry once the stated reason is addressed (or to leave behind, for un-migratable dust). */
  failed: Array<{ asset: string; amount: string; reason: string }>;
}

const ASSET_DECIMALS: Record<string, number> = { ETH: 18, USDC: 6 };

/** Custom errors the retired soft-era Entrypoint can revert with. Their source lives with the
 * retired contracts, not this repo, so they are re-declared here purely to decode reverts —
 * without them ethers reports only "unknown custom error" and the real cause is invisible. */
const LEGACY_ERROR_ABI = [
  "error WithdrawalCostExceedsAmount(uint256,uint256)",
  "error InvalidZKProof()",
  "error NullifierAlreadySpent()",
  "error InvalidStateRoot()",
  "error ContractPaused()",
  "error InvalidRecipient()",
  "error InvalidWithdrawalAmount()",
];

function revertData(error: unknown): string | null {
  // ethers v6 puts the revert payload in different places depending on whether the failure came
  // from a staticCall, an estimateGas, or the provider's own error envelope.
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string | null => {
    if (!node || typeof node !== "object" || depth > 5 || seen.has(node)) return null;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    const d = rec.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d;
    for (const key of ["info", "error", "cause", "value"]) {
      const found = walk(rec[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(error, 0);
}

/**
 * Turn a failed migration step into something a person can act on.
 *
 * The case that matters in practice is WithdrawalCostExceedsAmount: the old vault refuses to pay
 * out less than the withdrawal costs, so dust is permanently un-migratable and retrying is
 * pointless. Its two arguments are (cost, amount) in some order that the retired source no longer
 * pins down here — but the error only fires when cost exceeds amount, so the larger value is
 * always the cost. That inference holds regardless of declaration order.
 */
export function explainMigrationError(error: unknown, asset: string): string {
  const data = revertData(error);
  if (data) {
    try {
      const parsed = new ethers.Interface(LEGACY_ERROR_ABI).parseError(data);
      if (parsed?.name === "WithdrawalCostExceedsAmount") {
        const [a, b] = [BigInt(parsed.args[0]), BigInt(parsed.args[1])];
        const cost = a > b ? a : b;
        const amount = a > b ? b : a;
        const dp = ASSET_DECIMALS[asset] ?? 18;
        // NOT "permanent": the cost is the vault's configured withdraw fee (flatGasWei), which the
        // entrypoint owner can recalibrate via setVaultFeeConfig. Saying otherwise told users to
        // write off recoverable funds — the USDC gas leg is currently set far above real cost, so
        // this fires on any dust-sized balance. Retrying at the SAME config genuinely won't help,
        // which is all the user can act on, so say that and nothing stronger.
        return (
          `the old vault's withdrawal fee (${ethers.formatUnits(cost, dp)} ${asset}) is currently ` +
          `higher than the ${ethers.formatUnits(amount, dp)} ${asset} held there, so it cannot be ` +
          `withdrawn right now. Retrying will not change this — the fee has to come down first.`
        );
      }
      if (parsed?.name === "NullifierAlreadySpent") {
        return "this note was already spent — it may have been migrated or withdrawn before.";
      }
      if (parsed?.name === "InvalidZKProof") {
        return "the old vault rejected the proof. Re-open the dashboard to rebuild it from a fresh tree.";
      }
      if (parsed?.name === "InvalidStateRoot") {
        return "the proof was built against a Merkle root the old vault no longer accepts. Reload and retry.";
      }
      if (parsed) return `the old vault reverted with ${parsed.name}.`;
    } catch {
      /* not one of the known errors — fall through to the raw message */
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

type Progress = (message: string) => void;

const leafCache = new Map<string, bigint[]>();

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function randomField(): bigint {
  let value = BigInt(ethers.hexlify(ethers.randomBytes(31))) % FIELD_SIZE;
  if (value === 0n) value = 1n;
  return value;
}

async function getLegacyContext(chainId: number, asset: string) {
  const generation = LEGACY_VAULTS[chainId];
  if (!generation) throw new Error("Legacy migration is not available on this network");
  const token = getTokens(chainId)[asset.toUpperCase()];
  if (!token) throw new Error(`Unsupported legacy asset: ${asset}`);
  const tokenAddress = asset.toUpperCase() === "ETH" ? NATIVE_TOKEN : token.address;
  const provider = new JsonRpcProvider(getReadProviderRpcUrl(chainId), chainId, {
    staticNetwork: true,
    // The browser proxy and free upstreams occasionally return an empty eth_call
    // response for a batch even though every individual call succeeds.
    batchMaxCount: 1,
  });
  const entrypoint = new Contract(generation.entrypoint, LEGACY_ENTRYPOINT_ABI, provider);
  const vaultAddress = String(await withTransientReadRetry(() => entrypoint.getVault(tokenAddress)));
  const vault = new Contract(vaultAddress, LEGACY_VAULT_ABI, provider);
  const treeAddress = String(await withTransientReadRetry(() => vault.merkleTree()));
  return { generation, token, tokenAddress, provider, vaultAddress, treeAddress };
}

async function fetchLegacyLeaves(chainId: number, asset: string): Promise<bigint[]> {
  const ctx = await getLegacyContext(chainId, asset);
  const cacheKey = `${chainId}:${ctx.treeAddress.toLowerCase()}`;
  const cached = leafCache.get(cacheKey);
  if (cached) return cached;

  // This generation is already indexed on the existing read-only vault index.
  // Never fall back to an archive log scan here: the configured free RPC permits
  // only 10 blocks per eth_getLogs request, which would hammer it ~24k times.
  const indexBase = (process.env.NEXT_PUBLIC_LEGACY_VAULT_INDEX_URL || DEFAULT_LEGACY_INDEX_URL)
    .replace(/\/+$/, "");
  const response = await withTransientReadRetry(async () => {
    const result = await fetch(
      `${indexBase}/leaves?chainId=${chainId}&asset=${encodeURIComponent(asset)}&fromIndex=0`,
      { headers: { Accept: "application/json" } },
    );
    if (result.status === 429 || result.status >= 500) {
      throw new Error(`Legacy index transient HTTP ${result.status}`);
    }
    return result;
  });
  if (!response.ok) throw new Error("The legacy vault index is unavailable; no transaction was submitted");
  const page = await response.json() as {
    fromIndex?: number;
    leaves?: string[];
    totalCount?: number;
    tipRoot?: string | null;
    contiguous?: boolean;
  };
  if (
    !Array.isArray(page.leaves) ||
    page.contiguous !== true ||
    Number(page.fromIndex ?? 0) !== 0 ||
    page.leaves.length === 0
  ) {
    throw new Error("The legacy vault index is unavailable; no transaction was submitted");
  }
  const tree = new Contract(ctx.treeAddress, MERKLE_TREE_READ_ABI, ctx.provider);
  const [root, size] = await Promise.all([
    withTransientReadRetry(() => tree.getRoot()),
    withTransientReadRetry(() => tree.getSize()),
  ]);
  if (
    page.leaves.length !== Number(size) ||
    Number(page.totalCount) !== Number(size) ||
    page.tipRoot !== root.toString()
  ) {
    throw new Error("The legacy vault index does not match the on-chain tree; refusing to build a proof");
  }
  const leaves = page.leaves.map(BigInt);
  leafCache.set(cacheKey, leaves);
  return leaves;
}

export async function findLegacyMigrationNotes(
  signer: Signer,
  chainId: number,
  onProgress: Progress = () => undefined,
): Promise<LegacyMigrationSummary> {
  if (!LEGACY_VAULTS[chainId]) return { notes: [], totals: {} };
  onProgress("Reading encrypted note backup…");
  const rows = await fetchCommitments(signer) as LegacyCommitmentCandidate[];
  const reservedRowIds = new Set<string>();
  if (typeof window !== "undefined") {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith("siphon-reserved-")) continue;
      try {
        const ids = JSON.parse(window.localStorage.getItem(key) ?? "[]");
        if (Array.isArray(ids)) ids.forEach((id) => typeof id === "string" && reservedRowIds.add(id));
      } catch { /* malformed reservation: server-side pending state remains the backstop */ }
    }
  }
  const notes: LegacyMigrationNote[] = [];
  for (const asset of ["ETH", "USDC"] as const) {
    onProgress(`Checking the old ${asset} vault…`);
    const leaves = await fetchLegacyLeaves(chainId, asset);
    const candidates = classifyLegacyCommitments(
      rows.filter((row) => row.asset.toUpperCase() === asset),
      new Set(leaves.map(String)),
      chainId,
      reservedRowIds,
    ) as LegacyMigrationNote[];
    const poseidon = await buildPoseidon();
    const F = poseidon.F;
    const ctx = await getLegacyContext(chainId, asset);
    const vault = new Contract(ctx.vaultAddress, LEGACY_VAULT_ABI, ctx.provider);
    const spentFlags = await mapWithConcurrency(candidates, 3, async (note) => {
      const nullifierHash = BigInt(F.toObject(poseidon([BigInt(note.decrypted.nullifier)])));
      return Boolean(await withTransientReadRetry(() => vault.nullifiers(nullifierHash)));
    });
    for (let i = 0; i < candidates.length; i++) {
      if (!spentFlags[i]) {
        notes.push(candidates[i]);
        continue;
      }
      markNoteSpentTyped(chainId, asset, candidates[i].decrypted.commitment, "true");
      void markCommitmentSpent(signer, candidates[i].id, "true").catch((error) =>
        console.warn("[migration] could not reconcile an already-spent legacy backup row:", error),
      );
    }
  }
  const totals: Record<string, number> = {};
  for (const note of notes) totals[note.asset] = (totals[note.asset] ?? 0) + Number(note.decrypted.amount);
  return { notes, totals };
}

function buildMerklePath(
  leaves: bigint[],
  leafIndex: number,
  zeros: bigint[],
  hash: (left: bigint, right: bigint) => bigint,
) {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let nodes = leaves.slice();
  let index = leafIndex;
  for (let level = 0; level < TREE_DEPTH; level++) {
    const isRight = index % 2;
    pathIndices.push(isRight);
    const sibling = isRight ? index - 1 : index + 1;
    pathElements.push(sibling < nodes.length ? nodes[sibling] : zeros[level]);
    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) next.push(hash(nodes[i], nodes[i + 1] ?? zeros[level]));
    nodes = next;
    index = Math.floor(index / 2);
  }
  return { pathElements, pathIndices, root: nodes[0] };
}

async function buildLegacyProof(note: LegacyMigrationNote, chainId: number, recipient: string) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash = (values: bigint[]) => BigInt(F.toObject(poseidon(values)));
  const leaves = await fetchLegacyLeaves(chainId, note.asset);
  const commitment = BigInt(note.decrypted.commitment);
  const leafIndex = leaves.findIndex((leaf) => leaf === commitment);
  if (leafIndex < 0) throw new Error("Legacy commitment is no longer present in the old vault tree");
  const amount = ethers.parseUnits(note.decrypted.amount, getTokens(chainId)[note.asset].decimals);
  const nullifier = BigInt(note.decrypted.nullifier);
  const secret = BigInt(note.decrypted.secret);
  if (hash([amount, hash([nullifier, secret])]) !== commitment) {
    throw new Error("Legacy note secret does not reproduce its on-chain commitment");
  }
  const ctx = await getLegacyContext(chainId, note.asset);
  if (await withTransientReadRetry(() =>
    new Contract(ctx.vaultAddress, LEGACY_VAULT_ABI, ctx.provider).nullifiers(hash([nullifier])),
  )) {
    throw new Error("This legacy note was already withdrawn");
  }
  const zeros = [0n];
  for (let i = 1; i < TREE_DEPTH; i++) zeros.push(hash([zeros[i - 1], zeros[i - 1]]));
  const path = buildMerklePath(leaves, leafIndex, zeros, (a, b) => hash([a, b]));
  const newNullifier = randomField();
  const newSecret = randomField();
  const nullifierHash = hash([nullifier]);
  const changeCommitment = hash([0n, hash([newNullifier, newSecret])]);
  const input = buildLegacyW1CircuitInput({
    withdrawnValue: amount.toString(),
    stateRoot: path.root.toString(),
    changeCommitment: changeCommitment.toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: BigInt(recipient).toString(),
    inValue: amount.toString(),
    inNullifier: nullifier.toString(),
    inSecret: secret.toString(),
    changeNullifier: newNullifier.toString(),
    changeSecret: newSecret.toString(),
    pathElements: path.pathElements.map(String),
    pathIndices: path.pathIndices,
  });
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    zkUrl("/zk/legacy/soft-era/w1/main_w1.wasm"),
    zkUrl("/zk/legacy/soft-era/w1/zkey_final.zkey"),
  );
  const verificationKey = await fetch(zkUrl("/zk/legacy/soft-era/w1/verification_key.json")).then((res) => {
    if (!res.ok) throw new Error("Legacy verification key is unavailable");
    return res.json();
  });
  if (!await snarkjs.groth16.verify(verificationKey, publicSignals, proof)) {
    throw new Error("Legacy proof failed local verification");
  }
  return {
    ctx,
    amount,
    stateRoot: path.root,
    nullifierHash,
    changeCommitment,
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    pC: [proof.pi_c[0], proof.pi_c[1]],
  };
}

function receiptGasCost(receipt: TransactionReceipt): bigint {
  const gasPrice = receipt.gasPrice ?? 0n;
  return receipt.gasUsed * gasPrice;
}

async function migrateOne(note: LegacyMigrationNote, signer: Signer, chainId: number, onProgress: Progress) {
  const recipient = await signer.getAddress();
  onProgress(`Generating old-vault proof for ${note.decrypted.amount} ${note.asset}…`);
  const built = await buildLegacyProof(note, chainId, recipient);
  const walletEntrypoint = new Contract(built.ctx.generation.entrypoint, LEGACY_ENTRYPOINT_ABI, signer);
  const tokenContract = note.asset === "ETH" ? null : new Contract(
    built.ctx.tokenAddress,
    ["function balanceOf(address) view returns (uint256)"],
    built.ctx.provider,
  );
  const before = tokenContract
    ? BigInt((await tokenContract.balanceOf(recipient)).toString())
    : await built.ctx.provider.getBalance(recipient);
  const args = [
    built.ctx.tokenAddress, recipient, built.amount, built.stateRoot, [built.nullifierHash],
    built.changeCommitment, built.pA, built.pB, built.pC,
  ] as const;
  return runConfirmedMigrationStep({
    withdraw: async () => {
      onProgress(`Confirm the old-vault withdrawal for ${note.asset}…`);
      await withTransientReadRetry(() => walletEntrypoint.getFunction("withdraw").staticCall(...args));
      const withdrawTx = await walletEntrypoint.getFunction("withdraw")(...args);
      const receipt = await withdrawTx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Legacy withdrawal did not confirm");
      const after = tokenContract
        ? BigInt((await tokenContract.balanceOf(recipient)).toString())
        : await built.ctx.provider.getBalance(recipient);
      const received = tokenContract ? after - before : receivedNativeAmount(before, after, receiptGasCost(receipt));
      if (received <= 0n) throw new Error(`No ${note.asset} was received from the legacy vault`);
      return { receipt, receivedHuman: ethers.formatUnits(received, built.ctx.token.decimals) };
    },
    markSourceSpent: async () => {
      markNoteSpentTyped(chainId, note.asset, note.decrypted.commitment, "true");
      try {
        await markCommitmentSpent(signer, note.id, "true");
      } catch (error) {
        // The on-chain nullifier is authoritative. Do not strand successfully
        // withdrawn funds in the wallet merely because backup bookkeeping is down.
        console.warn("[migration] legacy backup spent flag update failed:", error);
      }
    },
    deposit: async ({ receipt, receivedHuman }) => {
      onProgress(`Depositing ${receivedHuman} ${note.asset} into the new private vault…`);
      const deposited = await deposit(note.asset, receivedHuman);
      if (!deposited.success) {
        return {
          walletOnly: true as const,
          asset: note.asset,
          amount: receivedHuman,
          withdrawTx: receipt.hash,
          error: deposited.error ?? "New-vault deposit failed",
        };
      }
      if (!deposited.aspAdmitted) {
        return {
          walletOnly: false as const,
          admissionPending: true as const,
          asset: note.asset,
          amount: receivedHuman,
          withdrawTx: receipt.hash,
          depositTx: deposited.executeTransaction ?? "",
          error: deposited.aspAdmissionError ?? "ASP admission/root publication is pending",
        };
      }
      return {
        walletOnly: false as const,
        admissionPending: false as const,
        asset: note.asset,
        amount: receivedHuman,
        withdrawTx: receipt.hash,
        depositTx: deposited.executeTransaction ?? "",
      };
    },
  });
}

export async function migrateLegacyNotes(
  notes: LegacyMigrationNote[],
  signer: Signer,
  chainId: number,
  onProgress: Progress = () => undefined,
): Promise<LegacyMigrationResult> {
  const current = getNetwork(chainId);
  const legacy = LEGACY_VAULTS[chainId];
  if (!legacy || current.entrypoint.toLowerCase() === legacy.entrypoint.toLowerCase()) {
    throw new Error("A distinct Hard-ASP destination vault is not active on this network");
  }
  const migrated: LegacyMigrationResult["migrated"] = [];
  const pendingAdmission: LegacyMigrationResult["pendingAdmission"] = [];
  const walletOnly: LegacyMigrationResult["walletOnly"] = [];
  const failed: LegacyMigrationResult["failed"] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    onProgress(`Migrating legacy note ${i + 1} of ${notes.length}…`);
    try {
      const result = await migrateOne(note, signer, chainId, onProgress);
      if (result.walletOnly) walletOnly.push(result);
      else if (result.admissionPending) pendingAdmission.push(result);
      else migrated.push(result);
    } catch (error) {
      // One note must never abort the rest. Un-migratable dust is common in the old vault, and
      // letting it throw stranded every other note — including ones already migrated in this
      // run, whose results were discarded with the thrown call. migrateOne simulates the
      // withdrawal before sending it, so a note that lands here moved no funds on-chain.
      console.warn(`[migration] note ${i + 1}/${notes.length} (${note.asset}) failed:`, error);
      failed.push({
        asset: note.asset,
        amount: note.decrypted.amount,
        reason: explainMigrationError(error, note.asset),
      });
    }
  }
  return { migrated, pendingAdmission, walletOnly, failed };
}

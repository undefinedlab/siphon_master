/**
 * Siphon v4 shielded-swap client — SELF-CONTAINED, direct-submit against real WETH/USDC.
 *
 * The user's own wallet submits every tx (deposit / shieldedSwap / withdraw). No executor: the v4
 * hook removed the custody window, and the on-chain fix `msg.sender == recipient` requires the
 * proof-bound recipient to be the submitter. So instant swaps go straight from the browser to the
 * vault, exactly like v3's instantSwap — just against the v4 pool.
 *
 * Deployed on Ethereum Sepolia. Addresses come from the contracts deployment file
 * (siphon-contracts/evm/ignition/deployments/chain-11155111/v4_deployed_addresses.json).
 *
 * Proving reuses the browser artifacts the rest of the app already ships:
 *   swap    → /zk/swap/{main_swap.wasm,zkey_final.zkey}   (prepareSwapTransaction)
 *   w1      → /zk/w1/{main_w1.wasm,zkey_final.zkey}        (prepareWithdrawalTransactionMulti(_,1))
 */
import { ethers, type Signer } from "ethers";
// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();
import { prepareSwapTransaction, prepareWithdrawalTransactionMulti, proofToCalldata } from "../generateProof";
import {
  V4,
  LEGACY_V4,
  REAL_POOL,
  VAULT_ABI,
  ERC20_ABI,
  MERKLE_TREE_ABI,
  DEPOSITOR_ABI,
  WETH_ADDRESS,
  TREE_DEPTH,
  MIN_SQRT_PRICE_PLUS_1,
  MAX_SQRT_PRICE_MINUS_1,
  type V4Pool,
} from "./config";
import {
  addNote,
  listNotes,
  markSpent,
  listPendingOutputs,
  removePendingOutput,
  type V4Note,
} from "./noteStore";
import { getLogsChunked } from "../getLogsChunked";
import { getReadProviderRpcUrl } from "../networks";

/* ------------------------------------------------------------------ poseidon + merkle helpers */

let _poseidon: any = null;
let _readProvider: ethers.JsonRpcProvider | null = null;

/**
 * Wallet providers are for signatures and transaction submission only. Historical proof inputs
 * go through the app's read RPC (normally /api/rpc), avoiding MetaMask/Infura eth_getLogs limits
 * and preventing read failures from being presented as wallet transaction errors.
 */
function getV4ReadProvider(): ethers.JsonRpcProvider {
  if (_readProvider) return _readProvider;
  const network = ethers.Network.from(V4.chainId);
  _readProvider = new ethers.JsonRpcProvider(getReadProviderRpcUrl(V4.chainId), network, {
    staticNetwork: network,
    // The Sepolia archive fallback accepts at most three JSON-RPC calls per batch.
    batchMaxCount: 3,
  });
  return _readProvider;
}

async function poseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}
async function hashers() {
  const p = await poseidon();
  const F = p.F;
  return {
    F,
    h2: (a: bigint, b: bigint) => BigInt(F.toObject(p([a, b]))),
    h1: (a: bigint) => BigInt(F.toObject(p([a]))),
  };
}

/** Precomputed empty-subtree zeros (depth-32 Poseidon), matches MerkleTree.sol. */
async function zeros(): Promise<bigint[]> {
  const { h2 } = await hashers();
  const z: bigint[] = [0n];
  for (let i = 1; i < TREE_DEPTH; i++) z[i] = h2(z[i - 1], z[i - 1]);
  return z;
}

/** Reconstruct a tree's ordered leaf set from its LeafInserted events (positions matter). */
async function readLeaves(provider: ethers.Provider, treeAddr: string, deployBlock: number = V4.deployBlock): Promise<bigint[]> {
  const topic = ethers.id("LeafInserted(uint256,uint256,uint256)");
  const latest = await provider.getBlockNumber();
  const logs = await getLogsChunked(
    provider,
    { address: treeAddr, topics: [topic] },
    deployBlock,
    latest,
  );
  const leaves: bigint[] = [];
  const abi = ethers.AbiCoder.defaultAbiCoder();
  for (const log of logs) {
    const [index, leaf] = abi.decode(["uint256", "uint256", "uint256"], log.data);
    leaves[Number(index)] = BigInt(leaf);
  }
  return leaves;
}

/** Build the Merkle membership path for leafIndex against the full ordered leaf set. */
async function merklePath(leaves: bigint[], leafIndex: number) {
  const { h2 } = await hashers();
  const z = await zeros();
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let level = leaves.slice();
  let idx = leafIndex;
  for (let d = 0; d < TREE_DEPTH; d++) {
    const isRight = idx % 2;
    pathIndices.push(isRight);
    const sib = isRight ? idx - 1 : idx + 1;
    pathElements.push(sib < level.length ? level[sib] : z[d]);
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(h2(level[i], i + 1 < level.length ? level[i + 1] : z[d]));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { pathElements, pathIndices };
}

function randField(): bigint {
  // 31 bytes stays inside BN254's field.
  return BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
}

async function commitment(value: bigint, nullifier: bigint, secret: bigint): Promise<bigint> {
  const { h2 } = await hashers();
  return h2(value, h2(nullifier, secret));
}

interface V4DeploymentRef {
  vault: string;
  hook: string;
  tree: string;
  deployBlock: number;
}

function currentDeployment(token: string): V4DeploymentRef {
  return { vault: V4.vault, hook: V4.hook, tree: V4.treeOf(token), deployBlock: V4.deployBlock };
}

/** Notes predating deployment metadata are unambiguously owned by the previous immutable vault. */
function deploymentForNote(note: Pick<V4Note, "token" | "vault" | "tree" | "hook" | "deployBlock">): V4DeploymentRef {
  if (note.vault) {
    const isCurrent = note.vault.toLowerCase() === V4.vault.toLowerCase();
    return {
      vault: note.vault,
      hook: note.hook ?? (isCurrent ? V4.hook : LEGACY_V4.hook),
      tree: note.tree ?? (isCurrent ? V4.treeOf(note.token) : LEGACY_V4.trees[note.token.toLowerCase()]),
      deployBlock: note.deployBlock ?? (isCurrent ? V4.deployBlock : LEGACY_V4.deployBlock),
    };
  }
  const tree = LEGACY_V4.trees[note.token.toLowerCase()];
  if (!tree) throw new Error(`legacy v4 tree is unknown for token ${note.token}`);
  return { vault: LEGACY_V4.vault, hook: LEGACY_V4.hook, tree, deployBlock: LEGACY_V4.deployBlock };
}

export function isCurrentV4Note(note: V4Note): boolean {
  return deploymentForNote(note).vault.toLowerCase() === V4.vault.toLowerCase();
}

function withCurrentDeployment(token: string) {
  return currentDeployment(token);
}

/* ------------------------------------------------------------------ token helpers */

/* ------------------------------------------------------------------ 1. DEPOSIT */

/**
 * Shield `amount` of `token` into the vault as a fresh note. The note secrets are stored locally so
 * they can be spent later — losing them strands the funds (same trust model as v3).
 */
export async function depositV4(signer: Signer, token: string, amount: bigint): Promise<{ txHash: string; note: V4Note }> {
  const { h2 } = await hashers();
  const nullifier = randField();
  const secret = randField();
  const precommitment = h2(nullifier, secret);

  const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
  await (await erc20.approve(V4.vault, amount)).wait();

  const vault = new ethers.Contract(V4.vault, VAULT_ABI, signer);
  // Explicit gasLimit — deposit does a depth-32 Poseidon Merkle insert via external PoseidonT3 calls.
  // Under the 63/64 gas-forwarding rule an auto-estimate can starve the inner calls (the insert
  // reverts, surfacing as MetaMask -32603 / "could not coalesce"). Same fix the v3 deposit uses.
  const tx = await vault.deposit(token, amount, precommitment, { gasLimit: 2_000_000n });
  await tx.wait();

  const note: V4Note = {
    token,
    value: amount.toString(),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    commitment: (await commitment(amount, nullifier, secret)).toString(),
    spent: false,
    ...withCurrentDeployment(token),
  };
  addNote(note);
  return { txHash: tx.hash, note };
}

/**
 * Shield native ETH in ONE tx via the depositor: wraps msg.value → WETH and deposits atomically, no
 * approve step (so any ETH-only wallet works and there's no cross-tx allowance race). The note lands
 * in the WETH tree.
 */
export async function depositNativeV4(signer: Signer, amount: bigint): Promise<{ txHash: string; note: V4Note }> {
  const { h2 } = await hashers();
  const nullifier = randField();
  const secret = randField();
  const precommitment = h2(nullifier, secret);

  const depositor = new ethers.Contract(V4.depositor, DEPOSITOR_ABI, signer);
  const tx = await depositor.depositETH(precommitment, { value: amount, gasLimit: 2_000_000n });
  await tx.wait();

  const note: V4Note = {
    token: WETH_ADDRESS,
    value: amount.toString(),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    commitment: (await commitment(amount, nullifier, secret)).toString(),
    spent: false,
    ...withCurrentDeployment(WETH_ADDRESS),
  };
  addNote(note);
  return { txHash: tx.hash, note };
}

/**
 * Shield an ERC20 via the depositor: approve the depositor once (skipped if already sufficient), then
 * depositToken pulls + deposits atomically — the vault-side allowance is set inside the same tx, so
 * there's no approve→deposit race like the direct depositV4 path.
 */
export async function depositTokenV4(signer: Signer, token: string, amount: bigint): Promise<{ txHash: string; note: V4Note }> {
  const { h2 } = await hashers();
  const nullifier = randField();
  const secret = randField();
  const precommitment = h2(nullifier, secret);

  const me = await signer.getAddress();
  const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
  const allow: bigint = await erc20.allowance(me, V4.depositor);
  if (allow < amount) await (await erc20.approve(V4.depositor, amount)).wait();

  const depositor = new ethers.Contract(V4.depositor, DEPOSITOR_ABI, signer);
  const tx = await depositor.depositToken(token, amount, precommitment, { gasLimit: 2_000_000n });
  await tx.wait();

  const note: V4Note = {
    token,
    value: amount.toString(),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    commitment: (await commitment(amount, nullifier, secret)).toString(),
    spent: false,
    ...withCurrentDeployment(token),
  };
  addNote(note);
  return { txHash: tx.hash, note };
}

/* ------------------------------------------------------------------ 2. SHIELDED SWAP */

/** Low 160 bits of the v4 PoolId — the value the circuit's `pool` signal binds to. */
export function poolIdLow160(poolKey: typeof V4.poolKey): bigint {
  const id = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ),
  );
  return BigInt(id) & ((1n << 160n) - 1n);
}

/**
 * Executor-ready v4 swap proof (flat), the exact shape execute_shielded_swap_v4 decodes. `venue`
 * marks it so the executor routes it through the hook. When recipient == the executor wallet the
 * proof is a STRATEGY LEG (the executor submits it later); when recipient == the user it's a
 * direct instant swap the user submits themselves.
 */
export interface V4SwapProof {
  venue: "v4";
  srcToken: string;
  dstToken: string;
  recipient: string;
  amountIn: string;
  minAmountOut: string;
  fee: number;
  pool: string;               // v4 PoolId low 160 bits (bound into the proof)
  stateRoot: string;
  nullifierHashes: string[];
  changeCommitment: string;
  newCommitment: string;      // == changeCommitment (executor reads either)
  outputPrecommitment: string;
  precommitment: string;      // alias of outputPrecommitment (executor reads either)
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
}

/** Secrets for a swap output note whose VALUE (amountOut) is only known after the swap executes. */
export interface V4OutputSecrets {
  token: string;
  nullifier: string;
  secret: string;
  precommitment: string;
  vault?: string;
  tree?: string;
  hook?: string;
  deployBlock?: number;
}

export interface PreparedV4Swap {
  proof: V4SwapProof;
  poolKey: typeof V4.poolKey;
  swapParams: { zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint };
  hookData: string;
  spentCommitment: string;         // input note commitment to mark spent once the swap lands
  changeNote: V4Note | null;       // fully known (value = inValue - amountIn); null if no change
  outputSecrets: V4OutputSecrets;  // amountOut filled in later (event) — see reconcileV4OutputNote
}

/**
 * Build a shielded-swap proof + calldata WITHOUT submitting. `recipient` is bound into the proof
 * (the hook enforces msg.sender == recipient), so the direct path passes the user and the strategy
 * path passes the executor. The output note's value isn't known until the swap executes, so only its
 * secrets are returned — the caller persists them and reconciles the amount from the event later.
 */
export async function prepareV4Swap(
  signer: Signer,
  opts: { inputNote: V4Note; amountIn: bigint; minAmountOut?: bigint; zeroForOne?: boolean; recipient: string; pool?: V4Pool },
): Promise<PreparedV4Swap> {
  const provider = getV4ReadProvider();
  const { h2, h1 } = await hashers();
  const recipient = ethers.getAddress(opts.recipient);
  const pool = opts.pool ?? REAL_POOL;
  const poolKey = pool.poolKey;
  const zeroForOne = opts.zeroForOne ?? true;
  const minAmountOut = opts.minAmountOut ?? 0n;

  if (!isCurrentV4Note(opts.inputNote)) {
    throw new Error("This note belongs to the previous v4 vault; withdraw it before creating a new strategy.");
  }

  const inToken = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const outToken = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const inTree = zeroForOne ? pool.token0.tree : pool.token1.tree;

  // Prove membership of the input note against the INPUT token's tree.
  const leaves = await readLeaves(provider, inTree);
  const noteValue = BigInt(opts.inputNote.value);
  const leafCommit = await commitment(noteValue, BigInt(opts.inputNote.nullifier), BigInt(opts.inputNote.secret));
  const leafIndex = leaves.findIndex((l) => l === leafCommit);
  if (leafIndex === -1) throw new Error("input note not found in the input token's tree");

  const { pathElements, pathIndices } = await merklePath(leaves, leafIndex);

  // Change note for the remainder.
  const changeValue = noteValue - opts.amountIn;
  if (changeValue < 0n) throw new Error("amountIn exceeds the note value");
  const changeNullifier = randField();
  const changeSecret = randField();

  // Output note secrets — kept so the owner can withdraw later. Only the precommitment is public.
  const outNullifier = randField();
  const outSecret = randField();
  const outputPrecommitment = h2(outNullifier, outSecret);

  const treeC = new ethers.Contract(inTree, MERKLE_TREE_ABI, provider);
  const stateRoot = BigInt((await treeC.getRoot()).toString());

  const circuitInput = {
    amountIn: opts.amountIn.toString(),
    stateRoot: stateRoot.toString(),
    newCommitment: h2(changeValue, h2(changeNullifier, changeSecret)).toString(),
    nullifierHash: h1(BigInt(opts.inputNote.nullifier)).toString(),
    recipient: BigInt(recipient).toString(), // hook enforces msg.sender == recipient (front-run protection)
    pool: poolIdLow160(poolKey).toString(),
    dstToken: BigInt(outToken).toString(),
    fee: BigInt(poolKey.fee).toString(),
    minAmountOut: minAmountOut.toString(),
    inValue: noteValue.toString(),
    inNullifier: opts.inputNote.nullifier,
    inSecret: opts.inputNote.secret,
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
    changeNullifier: changeNullifier.toString(),
    changeSecret: changeSecret.toString(),
  };

  const { proof, publicSignals } = await prepareSwapTransaction(circuitInput);
  const { pA, pB, pC } = proofToCalldata(proof);
  const changeCommitment = BigInt(publicSignals[2]); // change commitment as proven

  const hookData = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(uint256 stateRoot,uint256 nullifierHash,uint256 changeCommitment,address recipient,address dstToken,uint256 fee,uint256 minAmountOut,uint256 amountIn,uint256 precommitment,uint256[2] pA,uint256[2][2] pB,uint256[2] pC)",
    ],
    [[
      stateRoot,
      BigInt(circuitInput.nullifierHash),
      changeCommitment,
      recipient,
      outToken,
      BigInt(poolKey.fee),
      minAmountOut,
      opts.amountIn,
      outputPrecommitment,
      pA, pB, pC,
    ]],
  );

  const proofOut: V4SwapProof = {
    venue: "v4",
    srcToken: inToken,
    dstToken: outToken,
    recipient,
    amountIn: opts.amountIn.toString(),
    minAmountOut: minAmountOut.toString(),
    fee: Number(poolKey.fee),
    pool: poolIdLow160(poolKey).toString(),
    stateRoot: stateRoot.toString(),
    nullifierHashes: [circuitInput.nullifierHash],
    changeCommitment: changeCommitment.toString(),
    newCommitment: changeCommitment.toString(),
    outputPrecommitment: outputPrecommitment.toString(),
    precommitment: outputPrecommitment.toString(),
    pA: pA as [string, string],
    pB: pB as [[string, string], [string, string]],
    pC: pC as [string, string],
  };

  const changeNote: V4Note | null =
    changeValue > 0n
      ? {
          token: inToken,
          value: changeValue.toString(),
          nullifier: changeNullifier.toString(),
          secret: changeSecret.toString(),
          commitment: (await commitment(changeValue, changeNullifier, changeSecret)).toString(),
          spent: false,
          ...withCurrentDeployment(inToken),
        }
      : null;

  return {
    proof: proofOut,
    poolKey,
    // Price limit depends on direction: zeroForOne lowers price → MIN+1; the reverse raises it → MAX-1.
    swapParams: { zeroForOne, amountSpecified: -opts.amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_1 : MAX_SQRT_PRICE_MINUS_1 },
    hookData,
    spentCommitment: opts.inputNote.commitment,
    changeNote,
    outputSecrets: {
      token: outToken,
      nullifier: outNullifier.toString(),
      secret: outSecret.toString(),
      precommitment: outputPrecommitment.toString(),
      ...withCurrentDeployment(outToken),
    },
  };
}

/** Given a filled-in amountOut, materialise the full output note from its secrets. */
export async function reconcileV4OutputNote(secrets: V4OutputSecrets, amountOut: bigint): Promise<V4Note> {
  const { h2 } = await hashers();
  return {
    token: secrets.token,
    value: amountOut.toString(),
    nullifier: secrets.nullifier,
    secret: secrets.secret,
    commitment: h2(amountOut, BigInt(secrets.precommitment)).toString(),
    spent: false,
    vault: secrets.vault,
    tree: secrets.tree,
    hook: secrets.hook,
    deployBlock: secrets.deployBlock,
  };
}

/**
 * Promote pending strategy-leg outputs to spendable notes by matching each precommitment against
 * the hook's ShieldedSwap events (outputCommitment == Poseidon(amountOut, precommitment)). Call
 * after legs have fired; returns the number newly resolved. Without this the executor-swapped output
 * exists on-chain but the user can't reconstruct the note amount to withdraw it.
 */
export async function resolveV4OutputNotes(provider: ethers.Provider = getV4ReadProvider()): Promise<number> {
  const pending = listPendingOutputs();
  if (pending.length === 0) return 0;
  const { h2 } = await hashers();

  const iface = new ethers.Interface(VAULT_ABI);
  const topic = ethers.id("ShieldedSwap(bytes32,uint256,uint256,uint256,uint256)");
  const latest = await provider.getBlockNumber();
  // Scan each immutable deployment represented in pending metadata. Old entries have no metadata
  // and therefore resolve against LEGACY_V4; new entries scan only the fee-enabled hook.
  const deployments = new Map<string, V4DeploymentRef>();
  for (const s of pending) {
    const dep = deploymentForNote(s);
    deployments.set(dep.hook.toLowerCase(), dep);
  }
  const byHook = new Map<string, Map<string, bigint>>();
  for (const dep of deployments.values()) {
    const logs = await getLogsChunked(
      provider,
      { address: dep.hook, topics: [topic] },
      dep.deployBlock,
      latest,
    );
    const byOutCommit = new Map<string, bigint>();
    for (const log of logs) {
      try {
        const p = iface.parseLog(log);
        if (p?.name === "ShieldedSwap") byOutCommit.set(BigInt(p.args.outputCommitment).toString(), BigInt(p.args.amountOut));
      } catch { /* not ours */ }
    }
    byHook.set(dep.hook.toLowerCase(), byOutCommit);
  }

  let resolved = 0;
  for (const s of pending) {
    const dep = deploymentForNote(s);
    const byOutCommit = byHook.get(dep.hook.toLowerCase()) ?? new Map<string, bigint>();
    // Find the amountOut whose Poseidon(amountOut, precommitment) matches an emitted outputCommitment.
    for (const [outCommit, amountOut] of byOutCommit) {
      if (h2(amountOut, BigInt(s.precommitment)).toString() === outCommit) {
        addNote(await reconcileV4OutputNote(s, amountOut));
        removePendingOutput(s.precommitment);
        resolved++;
        break;
      }
    }
  }
  return resolved;
}

/**
 * Reconcile locally-unspent v4 notes against the vault's authoritative nullifier set. Strategy
 * construction marks inputs locally, but a restored/stale browser can still carry an old note;
 * checking the shared on-chain nullifier map prevents that metadata from inflating the dashboard.
 */
export async function reconcileV4SpentNotes(provider: ethers.Provider = getV4ReadProvider()): Promise<number> {
  const notes = listNotes();
  if (notes.length === 0) return 0;
  const { h1 } = await hashers();
  const flags = await Promise.all(
    notes.map((note) => {
      const dep = deploymentForNote(note);
      const vault = new ethers.Contract(dep.vault, VAULT_ABI, provider);
      return vault.nullifiers(h1(BigInt(note.nullifier)));
    }),
  );
  let marked = 0;
  notes.forEach((note, index) => {
    if (flags[index]) {
      markSpent(note.commitment);
      marked++;
    }
  });
  return marked;
}

/**
 * Swap `amountIn` of an input-token note (zeroForOne: currency0 → currency1) through the shielded
 * pool. The output is re-shielded as a new note the caller owns; nothing is sent to any EOA. The
 * caller (user) both submits and owns the output, so recipient == the submitter.
 */
export async function shieldedSwapV4(
  signer: Signer,
  opts: { inputNote: V4Note; amountIn: bigint; minAmountOut?: bigint; zeroForOne?: boolean; pool?: V4Pool },
): Promise<{ txHash: string; amountOut: bigint; outputNote: V4Note }> {
  const me = await signer.getAddress();
  const prep = await prepareV4Swap(signer, { ...opts, recipient: me });

  const vault = new ethers.Contract(V4.vault, VAULT_ABI, signer);
  // Explicit gasLimit — verify + burn + TWO Merkle inserts (change + output) + the pool swap. Matches
  // the executor's 3M for shieldedSwap; auto-estimate under-forwards to the PoseidonT3 inner calls.
  const tx = await vault.shieldedSwap(prep.poolKey, prep.swapParams, prep.hookData, { gasLimit: 3_000_000n });
  const receipt = await tx.wait();

  // Read amountOut from the ShieldedSwap event.
  const iface = new ethers.Interface(VAULT_ABI);
  let amountOut = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "ShieldedSwap") amountOut = BigInt(parsed.args.amountOut);
    } catch { /* not ours */ }
  }
  if (amountOut === 0n) throw new Error("ShieldedSwap event not found / zero output");

  // Persist the spendable notes: input spent, change + output created.
  markSpent(prep.spentCommitment);
  if (prep.changeNote) addNote(prep.changeNote);
  const outputNote = await reconcileV4OutputNote(prep.outputSecrets, amountOut);
  addNote(outputNote);

  return { txHash: tx.hash, amountOut, outputNote };
}

/* ------------------------------------------------------------------ 3. WITHDRAW */

/**
 * Spend all or part of one note back to a plain ERC20 transfer to `recipient` (defaults to the
 * caller). A partial withdrawal inserts a new private change note for the unspent remainder.
 */
export async function withdrawV4(
  signer: Signer,
  note: V4Note,
  recipient?: string,
  withdrawnValue?: bigint,
): Promise<{ txHash: string; amount: bigint }> {
  const provider = getV4ReadProvider();
  const { h1, h2 } = await hashers();
  const to = recipient ?? (await signer.getAddress());
  const deployment = deploymentForNote(note);
  const tree = deployment.tree;

  const leaves = await readLeaves(provider, tree, deployment.deployBlock);
  const noteValue = BigInt(note.value);
  const amount = withdrawnValue ?? noteValue;
  if (amount <= 0n) throw new Error("withdraw amount must be greater than zero");
  if (amount > noteValue) throw new Error("withdraw amount exceeds the selected private note");

  const leafCommit = await commitment(noteValue, BigInt(note.nullifier), BigInt(note.secret));
  const leafIndex = leaves.findIndex((l) => l === leafCommit);
  if (leafIndex === -1) throw new Error("note not found in tree");

  const { pathElements, pathIndices } = await merklePath(leaves, leafIndex);
  const changeNullifier = randField();
  const changeSecret = randField();
  const changeValue = noteValue - amount;
  const changePrecommitment = h2(changeNullifier, changeSecret);
  const changeCommitment = h2(changeValue, changePrecommitment);

  // Derive the root from the exact leaf snapshot used for the path. Reading getRoot() separately can
  // race a concurrent insert and give the circuit a root that does not match its witness. Historical
  // roots are permanent in this deployment, so the snapshot root remains valid on-chain.
  let stateRoot = leafCommit;
  for (let level = 0; level < pathElements.length; level++) {
    stateRoot = pathIndices[level] === 0
      ? h2(stateRoot, pathElements[level])
      : h2(pathElements[level], stateRoot);
  }
  const treeC = new ethers.Contract(tree, MERKLE_TREE_ABI, provider);
  if (!(await treeC.rootExists(stateRoot))) {
    throw new Error("v4 note tree is out of sync; refresh and retry");
  }

  // w1 circuit: single note, arrays of length 1.
  const circuitInput = {
    withdrawnValue: amount.toString(),
    stateRoot: stateRoot.toString(),
    changeCommitment: changeCommitment.toString(),
    nullifierHash: [h1(BigInt(note.nullifier)).toString()],
    recipient: BigInt(to).toString(),
    inValue: [noteValue.toString()],
    inNullifier: [note.nullifier],
    inSecret: [note.secret],
    pathElements: [pathElements.map(String)],
    pathIndices: [pathIndices.map(String)],
    changeNullifier: changeNullifier.toString(),
    changeSecret: changeSecret.toString(),
  };

  const { proof } = await prepareWithdrawalTransactionMulti(circuitInput, 1);
  const { pA, pB, pC } = proofToCalldata(proof);

  const vault = new ethers.Contract(deployment.vault, VAULT_ABI, signer);
  const tx = await vault.withdraw(
    note.token,
    to,
    amount,
    stateRoot,
    changeCommitment,
    h1(BigInt(note.nullifier)),
    pA, pB, pC,
    // Explicit gasLimit — verify + Merkle insert (change) + transfer; auto-estimate under-forwards
    // to the PoseidonT3 inner calls (63/64 rule) → -32603.
    { gasLimit: 2_000_000n },
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("v4 withdrawal did not confirm");

  markSpent(note.commitment);
  if (changeValue > 0n) {
    addNote({
      token: note.token,
      value: changeValue.toString(),
      nullifier: changeNullifier.toString(),
      secret: changeSecret.toString(),
      commitment: changeCommitment.toString(),
      spent: false,
      ...deployment,
    });
  }
  return { txHash: tx.hash, amount };
}

function notesForV4Withdrawal(token: string, amount: bigint): V4Note[] {
  const notes = listNotes(token);
  // Prefer a single covering note and the smallest such note, which minimizes both transactions
  // and the private change output.
  const single = notes
    .filter((note) => BigInt(note.value) >= amount)
    .sort((a, b) => BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0)[0];
  if (single) return [single];

  // The deployed v4 vault verifies W1 (one input note) only. Drain largest-first to cover the
  // amount with the minimum number of sequential W1 withdrawals; only the final note may be partial.
  const descending = notes.sort((a, b) =>
    BigInt(a.value) > BigInt(b.value) ? -1 : BigInt(a.value) < BigInt(b.value) ? 1 : 0
  );
  const selected: V4Note[] = [];
  let covered = 0n;
  for (const note of descending) {
    selected.push(note);
    covered += BigInt(note.value);
    if (covered >= amount) break;
  }
  return covered >= amount ? selected : [];
}

/** Number of wallet transactions required by the deployed single-note v4 withdraw verifier. */
export function v4WithdrawalTxCount(token: string, amount: bigint): number {
  return amount > 0n ? notesForV4Withdrawal(token, amount).length : 0;
}

export interface V4FeeQuote {
  feeWei: bigint;
  marginWei: bigint;
  gasReimburseWei: bigint;
  withdrawnValueWei: bigint;
  recipientReceivesWei: bigint;
  belowMinimum: boolean;
  feeExceedsAmount: boolean;
}

/** Sum the exact per-note fee that the selected immutable vault(s) will enforce. */
export async function quoteV4WithdrawalFee(token: string, amount: bigint): Promise<V4FeeQuote> {
  const selected = amount > 0n ? notesForV4Withdrawal(token, amount) : [];
  let remaining = amount;
  let feeWei = 0n;
  let marginWei = 0n;
  let gasReimburseWei = 0n;
  let belowMinimum = false;

  for (const note of selected) {
    const part = remaining < BigInt(note.value) ? remaining : BigInt(note.value);
    const dep = deploymentForNote(note);
    // The previous immutable vault predates fee views and is known to charge zero. Do not issue an
    // unsupported eth_call for it: some wallet/RPC combinations leave that revert pending and keep
    // the dashboard stuck on "Estimating fee…".
    if (dep.vault.toLowerCase() !== LEGACY_V4.vault.toLowerCase()) {
      const vault = new ethers.Contract(dep.vault, VAULT_ABI, getV4ReadProvider());
      try {
        const [enabled, , minWithdraw] = await vault.getFeeInfo(token);
        if (enabled) {
          const [fee, margin, gas] = await vault.quoteWithdrawFee(token, part);
          feeWei += BigInt(fee);
          marginWei += BigInt(margin);
          gasReimburseWei += BigInt(gas);
          if (BigInt(minWithdraw) > 0n && part < BigInt(minWithdraw)) belowMinimum = true;
        }
      } catch {
        // A deployment without fee views pays the proof-bound amount in full.
      }
    }
    remaining -= part;
  }

  const feeExceedsAmount = amount > 0n && feeWei >= amount;
  return {
    feeWei,
    marginWei,
    gasReimburseWei,
    withdrawnValueWei: amount,
    recipientReceivesWei: feeExceedsAmount ? 0n : amount - feeWei,
    belowMinimum,
    feeExceedsAmount,
  };
}

/** Solve v4 exact-receive by repeatedly applying the real per-note on-chain quote. */
export async function solveV4WithdrawalForExactReceive(token: string, target: bigint): Promise<V4FeeQuote> {
  let gross = target;
  let quote = await quoteV4WithdrawalFee(token, gross);
  for (let i = 0; i < 12 && quote.recipientReceivesWei < target; i++) {
    gross += target - quote.recipientReceivesWei + 1n;
    quote = await quoteV4WithdrawalFee(token, gross);
  }
  return quote;
}

/**
 * Withdraw `amount` across as few v4 notes as possible. Each selected note needs one proof and one
 * wallet transaction because the deployed v4 vault exposes only its W1 withdrawal verifier.
 */
export async function withdrawV4Amount(
  signer: Signer,
  token: string,
  amount: bigint,
  recipient?: string,
  onProgress?: (completed: number, total: number, txHash: string) => void,
): Promise<{ txHash: string; txHashes: string[]; amount: bigint }> {
  if (amount <= 0n) throw new Error("withdraw amount must be greater than zero");
  await reconcileV4SpentNotes();
  const notes = listNotes(token);
  const total = notes.reduce((sum, note) => sum + BigInt(note.value), 0n);
  if (total < amount) {
    throw new Error(`Insufficient v4 private balance: have ${total.toString()} base units`);
  }
  const selected = notesForV4Withdrawal(token, amount);
  if (selected.length === 0) throw new Error("Could not select v4 notes for withdrawal");

  let remaining = amount;
  const txHashes: string[] = [];
  for (let index = 0; index < selected.length; index++) {
    const note = selected[index];
    const noteValue = BigInt(note.value);
    const part = remaining < noteValue ? remaining : noteValue;
    try {
      const result = await withdrawV4(signer, note, recipient, part);
      txHashes.push(result.txHash);
      remaining -= part;
      onProgress?.(index + 1, selected.length, result.txHash);
    } catch (error) {
      if (txHashes.length > 0) {
        const done = amount - remaining;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Withdrew ${done.toString()} base units in ${txHashes.length} transaction(s), then stopped: ${reason}`);
      }
      throw error;
    }
  }
  return { txHash: txHashes[txHashes.length - 1], txHashes, amount };
}

export { listNotes };
export type { V4Note };

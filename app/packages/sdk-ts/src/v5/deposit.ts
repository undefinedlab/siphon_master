/**
 * v5 deposits, non-custodial: the SDK makes the note secrets and the calldata, the user's wallet
 * signs and broadcasts, and the SDK turns the receipt into a spendable note.
 *
 * Mirrors siphon-app src/lib/v3/depositV3.ts. Order matters and is the caller's job:
 *   1. prepareDeposit()        — PERSIST the returned secrets before anything is signed;
 *                                a mined deposit whose secrets were lost is unspendable forever
 *   2. screen with the ASP     — `POST /v1/v5/deposits/screen` (Siphon API) — deny/pending ⇒ stop
 *   3. depositTransactions()   — sign + send (approve first for ERC-20s)
 *   4. finalizeDeposit()       — receipt ⇒ Note (fails closed on any commitment mismatch)
 *   5. admit with the ASP      — `POST /v1/v5/deposits/admit`; spendable ~one admission bus later
 */
import { Interface, type Log } from "ethers";
import { chainConfig, NATIVE_TOKEN } from "./constants";
import { assetIdFromToken, deriveDepositLabel, hashCommitment, hashPrecommitment, noteAssetAddress, randomUserSalt } from "./noteCrypto";
import type { Note } from "./types";

export const VAULT_KERNEL_ABI = [
  "function deposit(address token, uint256 amount, uint256 userSalt, uint256 precommitment) external returns (uint256)",
  "function depositNative(uint256 userSalt, uint256 precommitment) external payable returns (uint256)",
  "function assets() external view returns (address)",
  "function spend(uint256[25] publicInputs, uint256[8] proof, uint256[5] compliancePublicInputs, uint256[8] complianceProof, (bytes rawPayee, uint256[8] splitCommitments) extra) external",
  // depositor NOT indexed, token indexed — see the note in depositV3.ts; a wrong flag fails to decode.
  "event Deposited(address depositor, address indexed token, uint256 amount, uint256 commitment, uint256 depositNonce, uint256 stateRootAfter)",
];
const ERC20_ABI = ["function approve(address spender, uint256 amount) external returns (bool)"];

const kernelIface = new Interface(VAULT_KERNEL_ABI);
const erc20Iface = new Interface(ERC20_ABI);

/** Everything needed to recover the deposit. Store it before signing; never send it anywhere. */
export interface PendingDeposit {
  chainId: number;
  /** What the user deposits: an ERC-20, or NATIVE_TOKEN / zero address for ETH. */
  token: string;
  amount: string;
  native: boolean;
  /** The ERC-20 the note will hold (WETH for ETH). */
  noteToken: string;
  nullifier: string;
  secret: string;
  /**
   * Salts the label. Public once deposited (it is a deposit() argument) and sent to the ASP for
   * screening — nothing may rely on the label being secret; the nullifier and secret are.
   */
  userSalt: string;
  precommitment: string;
}

export interface UnsignedTx {
  to: string;
  data: string;
  value: string;
  /** What this transaction does, for display. */
  description: string;
}

function isNativeToken(token: string): boolean {
  const t = (token || "").trim().toLowerCase();
  return !t || t === "0x0000000000000000000000000000000000000000" || t === NATIVE_TOKEN.toLowerCase();
}

export async function prepareDeposit(p: { chainId: number; token: string; amount: bigint | string }): Promise<PendingDeposit> {
  chainConfig(p.chainId);
  const amount = BigInt(p.amount);
  if (amount <= 0n) throw new Error("prepareDeposit: amount must be positive");
  const nullifier = randomUserSalt();
  const secret = randomUserSalt();
  const userSalt = randomUserSalt();
  return {
    chainId: p.chainId,
    token: p.token,
    amount: amount.toString(),
    native: isNativeToken(p.token),
    noteToken: noteAssetAddress(p.chainId, p.token),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    userSalt: userSalt.toString(),
    precommitment: (await hashPrecommitment(nullifier, secret)).toString(),
  };
}

/**
 * The wallet transactions, in order. ERC-20s approve the kernel's ASSET ADAPTER
 * (`VaultKernel.assets()`, pinned per chain), not the kernel — approving the kernel leaves the
 * deposit reverting. Build these locally and send only these: calldata from anywhere else could
 * name someone else's precommitment.
 */
export function depositTransactions(d: PendingDeposit, opts: { assetAdapter?: string } = {}): UnsignedTx[] {
  const cfg = chainConfig(d.chainId);
  const kernel = cfg.vaultKernel;
  if (opts.assetAdapter && opts.assetAdapter.toLowerCase() !== cfg.assetAdapter.toLowerCase()) {
    throw new Error(`depositTransactions: ${opts.assetAdapter} is not ${cfg.name}'s asset adapter (${cfg.assetAdapter})`);
  }
  if (d.native) {
    return [{
      to: kernel,
      data: kernelIface.encodeFunctionData("depositNative", [d.userSalt, d.precommitment]),
      value: d.amount,
      description: "Deposit ETH into the Siphon vault",
    }];
  }
  return [
    {
      to: d.token,
      data: erc20Iface.encodeFunctionData("approve", [cfg.assetAdapter, d.amount]),
      value: "0",
      description: "Approve the Siphon vault to take the deposit",
    },
    {
      to: kernel,
      data: kernelIface.encodeFunctionData("deposit", [d.token, d.amount, d.userSalt, d.precommitment]),
      value: "0",
      description: "Deposit into the Siphon vault",
    },
  ];
}

/**
 * Receipt ⇒ spendable Note. The note's value is the amount the kernel MEASURED (fee-on-transfer
 * safe), and the derived commitment must equal the one the kernel minted — otherwise the note
 * could never be proven, so refuse to return it.
 */
export async function finalizeDeposit(d: PendingDeposit, receipt: { logs: readonly Pick<Log, "address" | "topics" | "data">[] }): Promise<Note & { depositNonce: string }> {
  const kernel = chainConfig(d.chainId).vaultKernel.toLowerCase();
  const assetId = assetIdFromToken(d.noteToken);
  let sawDeposit = false;
  // A batched transaction (smart account, multicall) can hold several deposits: take the one these
  // secrets actually open, not merely the first.
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== kernel) continue;
    let args;
    try {
      const parsed = kernelIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "Deposited") continue;
      args = parsed.args;
    } catch {
      continue; // another event
    }
    sawDeposit = true;
    const ev = { amount: args.amount as bigint, commitment: args.commitment as bigint, depositNonce: args.depositNonce as bigint };
    const label = await deriveDepositLabel({ chainId: d.chainId, vaultAddress: kernel, depositNonce: ev.depositNonce, userSalt: BigInt(d.userSalt) });
    const commitment = await hashCommitment(ev.amount, label, assetId, BigInt(d.nullifier), BigInt(d.secret));
    if (commitment !== ev.commitment) continue;
    return {
      chainId: d.chainId,
      token: d.noteToken,
      assetId: assetId.toString(),
      value: ev.amount.toString(),
      label: label.toString(),
      nullifier: d.nullifier,
      secret: d.secret,
      commitment: commitment.toString(),
      depositNonce: ev.depositNonce.toString(),
    };
  }
  throw new Error(
    sawDeposit
      ? "finalizeDeposit: no Deposited event in this receipt matches these secrets — they do not match this deposit"
      : "finalizeDeposit: no Deposited event from the VaultKernel in this receipt",
  );
}

/** `VaultKernel.spend` for a proven bundle — permissionless, so any address may send it. */
export function spendTransaction(b: { chain_id: number; public_inputs: string[]; proof: string[]; compliancePublicInputs: string[]; complianceProof: string[]; extra: { rawPayee?: string; splitCommitments?: string[] } }): UnsignedTx {
  const splits = [...(b.extra.splitCommitments || [])];
  while (splits.length < 8) splits.push("0");
  return {
    to: chainConfig(b.chain_id).vaultKernel,
    data: kernelIface.encodeFunctionData("spend", [b.public_inputs, b.proof, b.compliancePublicInputs, b.complianceProof, [b.extra.rawPayee || "0x", splits.slice(0, 8)]]),
    value: "0",
    description: "Submit the private spend",
  };
}

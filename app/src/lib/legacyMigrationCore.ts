export interface LegacyCommitmentCandidate {
  id: string;
  asset: string;
  spent: string;
  decrypted: {
    chainId: number;
    commitment: string;
    amount: string;
    nullifier: string;
    secret: string;
    precommitment: string;
    nullifierHash: string;
    vaultAddress?: string;
  };
}

export interface LegacyW1CircuitInputParams {
  withdrawnValue: string;
  stateRoot: string;
  changeCommitment: string;
  nullifierHash: string;
  recipient: string;
  changeNullifier: string;
  changeSecret: string;
  inValue: string;
  inNullifier: string;
  inSecret: string;
  pathElements: string[];
  pathIndices: Array<string | number>;
}

/**
 * Builds the witness expected by the deployed soft-era single-note withdrawal
 * verifier. Its public signals are exactly:
 * [withdrawnValue, stateRoot, changeCommitment, nullifierHash, recipient].
 */
export function buildLegacyW1CircuitInput(params: LegacyW1CircuitInputParams) {
  return {
    withdrawnValue: params.withdrawnValue,
    stateRoot: params.stateRoot,
    changeCommitment: params.changeCommitment,
    nullifierHash: [params.nullifierHash],
    recipient: params.recipient,
    changeNullifier: params.changeNullifier,
    changeSecret: params.changeSecret,
    inValue: [params.inValue],
    inNullifier: [params.inNullifier],
    inSecret: [params.inSecret],
    pathElements: [params.pathElements],
    pathIndices: [params.pathIndices.map(String)],
  };
}

/**
 * Old rows predate vault-generation metadata, so metadata alone cannot safely
 * distinguish them from a fresh Hard-ASP deposit. Tree membership is the
 * authoritative discriminator: a commitment is legacy only when it is an
 * actual leaf in the pinned legacy tree.
 */
export function classifyLegacyCommitments<T extends LegacyCommitmentCandidate>(
  rows: T[],
  legacyLeaves: ReadonlySet<string>,
  chainId: number,
  reservedRowIds: ReadonlySet<string> = new Set(),
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const commitment = String(row.decrypted?.commitment ?? "");
    const amount = Number(row.decrypted?.amount);
    if (
      row.spent !== "false" ||
      reservedRowIds.has(row.id) ||
      Number(row.decrypted?.chainId) !== chainId ||
      !commitment ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !legacyLeaves.has(commitment) ||
      seen.has(commitment)
    ) return false;
    seen.add(commitment);
    return true;
  });
}

/** Wallet balance accounting for a native-token withdrawal submitted by the
 * same wallet that receives it. The raw delta includes the tx gas debit. */
export function receivedNativeAmount(
  beforeBalance: bigint,
  afterBalance: bigint,
  transactionGasCost: bigint,
): bigint {
  const received = afterBalance + transactionGasCost - beforeBalance;
  if (received <= 0n) throw new Error("No ETH was received from the legacy vault");
  return received;
}

/** Enforces the irreversible migration boundary: a source note cannot be
 * marked spent until the old-vault withdrawal has actually confirmed. */
export async function runConfirmedMigrationStep<TReceived, TResult>(ops: {
  withdraw: () => Promise<TReceived>;
  markSourceSpent: () => Promise<void>;
  deposit: (received: TReceived) => Promise<TResult>;
}): Promise<TResult> {
  const received = await ops.withdraw();
  await ops.markSourceSpent();
  return ops.deposit(received);
}

export async function withTransientReadRetry<T>(
  read: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let delay = 250;
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /missing revert data|429|transient http|too many requests|rate.?limit|timeout|network error|fetch failed|socket/i
        .test(message);
      if (!transient || attempt >= attempts - 1) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }
}

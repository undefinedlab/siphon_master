/**
 * Arm one v3 strategy leg: seal its note secrets to the enclave instead of pre-building a proof.
 *
 * A v2 leg ships a finished Groth16 proof built here in the browser. v3 cannot, because the
 * circuit binds `admittedRoot`/`revokedRoot` as public inputs and `ComplianceHub` demands the
 * live root — a proof built now is stale by the time the trigger fires.
 *
 * So arming ships two halves:
 *   - `public`  — everything that does NOT go stale, carried verbatim into the fire-time witness.
 *     That deliberately includes the STATE root and state path: `NoteTree.knownRoots` is unbounded
 *     (NoteTree.sol:8), so every state root ever inserted stays valid forever. Only the two ASP
 *     roots are refreshed in the enclave.
 *   - `sealedSecrets` — the note secrets, sealed to the enclave's ATTESTED x25519 key.
 *
 * The enclave derives the ASP and revoked-SMT witnesses itself from a full tree sync, so nothing
 * about which note is being spent leaves it at fire time.
 */
import { deriveSwapPublics } from "./actionPublicsV3";
import { deriveWithdrawPublics } from "./withdrawPublicsV3";
import { v3Config } from "./configV3";
import { randomLabelSalt } from "./complianceProofV3";
import { sealLegSecrets, type LegSecretsV3 } from "./sealLegSecretsV3";
import { buildStatePath } from "./stateTreeV3";

/** One leg's inputs, as the strategy builder knows them. */
export interface ArmLegParams {
  chainId: number;
  strategyId: string;
  legIndex: number;
  /** The slice note this leg spends — minted for this leg and exactly sized. */
  note: {
    value: bigint;
    nullifier: bigint;
    secret: bigint;
    label: bigint;
    assetId: bigint;
    commitment: bigint;
  };
  /** Current state-tree leaves; the path built from them stays valid (knownRoots is unbounded). */
  stateLeaves: bigint[];
  /** Payout leg: WITHDRAW the whole note to this address (the executor's bridge payee) instead of
   *  swapping. The executor bridges what it receives (bridge_payout). `swap` is then unused. */
  payee?: string;
  swap: {
    amountIn: bigint;
    change: bigint;
    pool: bigint;
    dstToken: bigint;
    fee: bigint;
    minAmountOut: bigint;
    outputPrecommitment: bigint;
  };
  /** Change-note secrets. */
  outNullifier: bigint;
  outSecret: bigint;
  /** Destination-note secrets — bind `outputPrecommitment`. */
  destNullifier: bigint;
  destSecret: bigint;
  /** ASP roots as of arming. Only used to derive `expectedPublic`; the enclave overwrites both. */
  admittedRoot: bigint;
  revokedRoot: bigint;
}

export interface ArmedLegPayload {
  strategyId: string;
  legIndex: number;
  sealedSecrets: string;
  public: Record<string, unknown>;
  /** Which chain this leg spends on.
   *
   *  One enclave serves several chains, and it binds `chainId`, the ComplianceHub and the
   *  VaultKernel into the attestation it signs at fire time. Sent at ARM time, not at prove time,
   *  so the value is sealed with the leg: the executor calls `/spend/prove`, so a chain taken from
   *  that request would let it choose which chain's hub an attestation authorises.
   *
   *  Omitting it makes the enclave fall back to its default chain — which is right for a
   *  single-chain deployment and silently wrong the moment a second one is configured. */
  chainId: number;
  /** Public limb 22 — the commitment of the note this leg will MINT when it fires.
   *
   *  Taken from the derived publics rather than re-hashed at the callsite: this is the exact value
   *  the circuit constrains and `VaultKernel` inserts, so a note stashed against it is guaranteed
   *  to match the leaf. Re-deriving would duplicate `deriveSwapPublics`'s destLabel==inLabel rule
   *  and could silently drift from it. */
  destCommitment: string;
}

/**
 * Assemble + seal one leg. Returns the exact body `POST /spend/arm` expects.
 *
 * Note the asymmetry in what is sealed: `value`/`assetId` are in the sealed half even though they
 * also appear in `expectedPublic`. Duplicating them costs nothing and keeps the sealed payload a
 * self-contained witness — the enclave never has to trust the unsealed half for a field the
 * circuit constrains.
 */
export async function buildArmedLeg(p: ArmLegParams): Promise<ArmedLegPayload> {
  const cfg = v3Config(p.chainId);
  if (!cfg) throw new Error(`armLeg: v3 is not configured for chain ${p.chainId}`);

  const leafIndex = p.stateLeaves.findIndex((l) => l === p.note.commitment);
  if (leafIndex < 0) {
    // Arming against a note the tree does not contain produces a witness that can never prove.
    // Failing here costs a retry; failing at fire time costs the arming fee and a dead strategy.
    throw new Error("armLeg: the slice note is not in the state tree — deposit not yet indexed?");
  }

  const statePath = await buildStatePath(p.stateLeaves, leafIndex);

  // COMPLIANCE_CIRCUIT_SPLIT: limb 24 binds this spend to a compliance proof over the same salt.
  // The leg is proved at FIRE time inside the enclave, so the salt has to travel with the sealed
  // witness — the enclave must reproduce this exact limb 24 or the kernel rejects the pair.
  const labelCommitSalt = randomLabelSalt();
  const roots = { stateRoot: statePath.root, admittedRoot: p.admittedRoot, revokedRoot: p.revokedRoot };
  const publics = p.payee
    ? await deriveWithdrawPublics({
        inputs: [{
          inValue: p.note.value,
          inNullifier: p.note.nullifier,
          inSecret: p.note.secret,
          inLabel: p.note.label,
          inAssetId: p.note.assetId,
        }],
        boundaryIndex: 0,
        primaryValue: p.note.value,
        secondaryValue: 0n,
        ...roots,
        outNullifier: p.outNullifier,
        outSecret: p.outSecret,
        rawPayee: p.payee,
        chainId: p.chainId,
        labelCommitSalt,
      })
    : await deriveSwapPublics({
    input: {
      inValue: p.note.value,
      inNullifier: p.note.nullifier,
      inSecret: p.note.secret,
      inLabel: p.note.label,
      inAssetId: p.note.assetId,
    },
    primaryValue: p.swap.amountIn,
    secondaryValue: p.swap.change,
    pool: p.swap.pool,
    dstToken: p.swap.dstToken,
    fee: p.swap.fee,
    minAmountOut: p.swap.minAmountOut,
    outputPrecommitment: p.swap.outputPrecommitment,
    outNullifier: p.outNullifier,
    outSecret: p.outSecret,
    roots,
    labelCommitSalt,
  });

  if (publics.length !== 25) {
    throw new Error(`armLeg: expectedPublic must be 25 limbs, got ${publics.length}`);
  }

  const secrets: LegSecretsV3 = {
    action: p.payee ? 0 : 2, // WITHDRAW to the payee, else SWAP
    inputs: [
      {
        value: p.note.value.toString(),
        nullifier: p.note.nullifier.toString(),
        secret: p.note.secret.toString(),
        label: p.note.label.toString(),
        assetId: p.note.assetId.toString(),
        stateLeafIndex: leafIndex,
      },
    ],
    outNullifier: p.outNullifier.toString(),
    outSecret: p.outSecret.toString(),
    destNullifier: p.destNullifier.toString(),
    destSecret: p.destSecret.toString(),
    // SEALED, not public. Limb 24 (labelCommit) is on chain; a salt an observer could read would
    // let them recompute the commit from a guessed label set and undo the unlinkability it exists
    // for. `LegSecrets::label_salt` in the enclave (serde camelCase) is the matching field.
    labelSalt: labelCommitSalt.toString(),
  };

  // Validates, attests, verifies the quote, then seals. Throws rather than shipping a payload the
  // enclave cannot use — or, worse, one sealed to an unverified pubkey.
  // Seal to the decryptor behind the executor submitArmedLeg will deliver to (cfg.executorUrl).
  const sealedSecrets = await sealLegSecrets(secrets, cfg.executorUrl || undefined);
  const swapPublic = p.payee
    ? {
        primaryValue: p.note.value.toString(),
        secondaryValue: "0",
        // The enclave hands this back as the spend's rawPayee; limb 15 binds it.
        rawPayeeHex: p.payee.toLowerCase().replace(/^0x/, ""),
        pool: "0",
        dstToken: "0",
        fee: "0",
        minAmountOut: "0",
        outputPrecommitment: "0",
      }
    : {
        primaryValue: p.swap.amountIn.toString(),
        secondaryValue: p.swap.change.toString(),
        rawPayeeHex: "00".repeat(20), // swap settles to the pool, not a payee
        pool: p.swap.pool.toString(),
        dstToken: p.swap.dstToken.toString(),
        fee: p.swap.fee.toString(),
        minAmountOut: p.swap.minAmountOut.toString(),
        outputPrecommitment: p.swap.outputPrecommitment.toString(),
      };

  return {
    destCommitment: publics[22],
    strategyId: p.strategyId,
    legIndex: p.legIndex,
    chainId: p.chainId,
    sealedSecrets,
    public: {
      stateRoot: statePath.root.toString(),
      boundaryIndex: 0,
      ...swapPublic,
      expectedPublic: publics,
      // One entry per input, in input order. The enclave refuses a count mismatch rather than
      // silently proving the wrong note.
      statePaths: [
        {
          pathElements: statePath.pathElements.map(String),
          pathIndices: statePath.pathIndices.map(Number),
        },
      ],
    },
  };
}

/**
 * Ship an armed leg to the enclave.
 *
 * Routed through the executor, which proxies to the decryptor — the CVM is not publicly reachable.
 * The payload is already sealed, so the proxy sees ciphertext.
 */
export async function submitArmedLeg(
  chainId: number,
  payload: ArmedLegPayload,
): Promise<{ ok: boolean; legKey?: string; error?: string }> {
  const cfg = v3Config(chainId);
  if (!cfg?.executorUrl) throw new Error(`armLeg: no executor URL for chain ${chainId}`);

  // `destCommitment` is for the caller only and must NOT go on the wire. It is the commitment of a
  // note that is not on-chain yet, so sending it would hand the executor — and the enclave's
  // stored leg — a link between this strategy and a private note, ahead of the chain publishing
  // it. The enclave derives it from the sealed witness anyway.
  const { destCommitment: _destCommitment, ...wire } = payload;

  const resp = await fetch(`${cfg.executorUrl}/spend/arm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wire),
  });
  if (!resp.ok) {
    return { ok: false, error: `arm failed: HTTP ${resp.status}` };
  }
  return resp.json();
}

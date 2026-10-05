/** ASP wire shapes — mirror siphon-app src/lib/v3/aspClientV3.ts. */
export interface ComplianceRoots {
  admittedRoot: string;
  revokedRoot: string;
}

export interface InputCompliance {
  inLabel: string;
  admittedLeafIndex: number;
  admittedPathElements: string[];
  admittedPathIndices: number[];
  revokedSmtPathElements: string[];
  revokedSmtPathIndices: number[];
  revokedSmtLeaf: string;
}

export interface ComplianceWitness {
  admittedRoot: string;
  revokedRoot: string;
  inputs: InputCompliance[];
}

/** A spendable private note. Every field is a decimal string except `leafIndex`. */
export interface Note {
  chainId: number;
  /** ERC-20 the note holds (WETH for native ETH deposits). */
  token: string;
  assetId: string;
  value: string;
  label: string;
  nullifier: string;
  secret: string;
  commitment: string;
  /** Set once known; optional because a fresh change note is not yet indexed. */
  leafIndex?: number;
}

/**
 * Where the SDK reads public chain + compliance state. The Siphon API implements it
 * (`SiphonClient.v5Data`); tests pass an in-memory one. None of these calls sees a secret.
 */
export interface V5DataSource {
  /** Ordered NoteTree leaves (commitments) for `chainId`. */
  stateLeaves(chainId: number): Promise<bigint[]>;
  /** ASP inclusion + revoked-SMT paths for `labels`, plus the current roots. */
  complianceWitness(chainId: number, labels: string[], opts?: { requireAdmittedPath?: boolean }): Promise<ComplianceWitness>;
}

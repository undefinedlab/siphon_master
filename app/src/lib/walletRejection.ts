/**
 * Is this wallet error the user clicking "Reject"?
 *
 * Standalone because both `handler.ts` (toast copy) and `noteAuth.ts` (decline memory) need it,
 * and handler.ts pulls in zkHandler → circomlibjs + wasm. Importing that from a store to ask one
 * boolean would put the proving stack in every bundle that touches Supabase.
 *
 * A rejection is a decision, not a fault: retrying it re-prompts, and re-prompting a wallet the
 * user just said no to is how you end up showing 260 popups in three hours.
 */
export function isUserRejection(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    reason?: string;
    shortMessage?: string;
    message?: string;
    info?: { error?: { code?: number } };
  };
  // ethers wraps the provider error, so the EIP-1193 code 4001 can be one level down.
  const code = e?.code ?? e?.info?.error?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const raw = String(e?.shortMessage || e?.reason || e?.message || err || '');
  return /user (rejected|denied)|action_rejected|denied transaction/i.test(raw);
}

/** What a failed wallet action shows: a rejection says so, and an ethers error gives its one-line
 *  shortMessage instead of the `action="sendTransaction", info={…}` dump in its message. */
export function walletActionError(err: unknown, fallback: string): string {
  if (isUserRejection(err)) return "Cancelled in your wallet.";
  const e = err as { shortMessage?: string; message?: string } | null;
  return e?.shortMessage || e?.message || fallback;
}

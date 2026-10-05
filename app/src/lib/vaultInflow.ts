/**
 * Candidate amounts for a note credited to a vault inside one transaction.
 *
 * The caller proves each candidate against `commitment == Poseidon(Poseidon(amount, label),
 * precommitment)`, so a wrong candidate is rejected rather than trusted. Offering one too many is
 * free; offering one too few makes the note unresolvable and the balance invisible.
 *
 * Lives apart from zkHandler so it can be tested — zkHandler pulls circomlibjs and wasm.
 */
import { ethers } from 'ethers';

export const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
export const WITHDRAWAL_TOPIC = ethers.id('Withdrawal(address,uint256)'); // WETH9 unwrap

export type MinimalLog = { address: string; topics: ReadonlyArray<string>; data: string };

const addrFromTopic = (t: string) => ('0x' + t.slice(26)).toLowerCase();

export function vaultInflowCandidatesFromLogs(
  logs: ReadonlyArray<MinimalLog>,
  vault: string,
): bigint[] {
  const target = vault.toLowerCase();
  const out: bigint[] = [];
  const inByToken = new Map<string, bigint>();
  const outByToken = new Map<string, bigint>();

  for (const log of logs) {
    // NativeVault.creditNote unwraps EXACTLY the amount it credits, so this wad IS the note amount
    // — no fee arithmetic and no archive read needed.
    if (log.topics[0] === WITHDRAWAL_TOPIC && log.topics.length >= 2) {
      if (addrFromTopic(log.topics[1]) === target) {
        try { out.push(BigInt(log.data)); } catch { /* non-standard — skip */ }
      }
      continue;
    }
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    let value: bigint;
    try { value = BigInt(log.data); } catch { continue; }
    const token = log.address.toLowerCase();
    if (addrFromTopic(log.topics[2]) === target) {
      inByToken.set(token, (inByToken.get(token) ?? 0n) + value);
    }
    if (addrFromTopic(log.topics[1]) === target) {
      outByToken.set(token, (outByToken.get(token) ?? 0n) + value);
    }
  }

  for (const [token, gross] of inByToken) {
    out.push(gross); // fee-free case, and every note created before the fill fee was switched on
    // Entrypoint.swapAndDeposit skims swapAndDepositFeeBps straight to the collector in this same
    // tx, so the note carries net while the inflow log still shows gross.
    const net = gross - (outByToken.get(token) ?? 0n);
    if (net > 0n && net !== gross) out.push(net);
  }

  return [...new Set(out)];
}

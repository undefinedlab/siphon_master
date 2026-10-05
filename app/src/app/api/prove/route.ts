export const runtime = 'nodejs';
// Thin wallet-authenticated proxy to the proving relayer. Deliberately does NOT import snarkjs
// (~300MB, busts the 250MB Vercel function limit) and deliberately does NOT shell out to a
// local prover: spawning child processes from a public HTTP route is attack surface we don't
// need, and the browser snarkjs path in generateProof.js already covers local / auth-fail fallback.

import { NextRequest, NextResponse } from 'next/server';
import {
  assertBrowserSameOrigin,
  privilegedWalletAuthMaxAgeSec,
  verifyPrivilegedWalletAuthHeaders,
  walletAuthResponse,
} from '@/lib/apiWalletAuth';
import { clientKeyFromRequest, isRateLimited } from '@/lib/graphHttpGuard';

// No default. An infra host baked into source is a rotation hazard and leaks topology, and a
// silent fallback is how the previous hardcoded-path bug survived unnoticed for months.
const PROVING_RELAYER_URL = (process.env.PROVING_RELAYER_URL || '').replace(/\/+$/, '');
// Relayer auth is server-side only. Prefer RELAYER_API_TOKEN or API_TOKEN — never rely on
// NEXT_PUBLIC_API_TOKEN (that value is visible to browsers and must not be used as a service secret).
const RELAYER_API_TOKEN = process.env.RELAYER_API_TOKEN || process.env.API_TOKEN || '';

const VALID_CIRCUITS = new Set([
  'w1', 'w2', 'w3', 'w4', 'w5', 'w6',
  'm2', 'm3', 'm4', 'm5', 'm6',
  'swap', 'split', 'ragequit',
]);

// Largest real witness input is a few hundred KB; anything past this is abuse, not a proof.
const MAX_INPUT_BYTES = 2_000_000;
const RELAYER_TIMEOUT_MS = 120_000;
const PROVE_RATE_MAX = Number(process.env.PROVE_HTTP_RATE_MAX || '20');

export async function POST(req: NextRequest) {
  const originDeny = assertBrowserSameOrigin(req);
  if (originDeny) {
    return NextResponse.json(originDeny.body, { status: originDeny.status });
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ error: 'Malformed body' }, { status: 400 });
  }

  const auth = verifyPrivilegedWalletAuthHeaders(
    req,
    bodyText,
    process.env,
    Math.floor(Date.now() / 1000),
    { maxAgeSec: privilegedWalletAuthMaxAgeSec() },
  );
  const denied = walletAuthResponse(auth);
  if (denied) return denied;
  const wallet = auth.ok ? auth.wallet : '';

  const ip = clientKeyFromRequest(req);
  if (isRateLimited(`prove:${ip}`, PROVE_RATE_MAX)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (wallet && wallet !== 'optional' && isRateLimited(`prove:w:${wallet}`, PROVE_RATE_MAX)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: { inputs?: unknown; circuit?: unknown };
  try {
    body = JSON.parse(bodyText) as { inputs?: unknown; circuit?: unknown };
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }

  const inputs = body.inputs;
  const circuit = String(body.circuit ?? '').toLowerCase();

  if (!inputs || typeof inputs !== 'object') {
    return NextResponse.json({ error: 'Missing inputs' }, { status: 400 });
  }
  // Validate BEFORE forwarding — previously this ran only on the local branch, so an arbitrary
  // circuit string reached the relayer unchecked.
  if (!VALID_CIRCUITS.has(circuit)) {
    return NextResponse.json(
      { error: `Invalid circuit '${circuit}'. Valid: ${[...VALID_CIRCUITS].sort().join(', ')}` },
      { status: 400 },
    );
  }

  if (Buffer.byteLength(bodyText, 'utf8') > MAX_INPUT_BYTES) {
    return NextResponse.json({ error: 'Inputs too large' }, { status: 413 });
  }

  if (!PROVING_RELAYER_URL) {
    // Loud and actionable. The client falls back to browser snarkjs on a non-200, so this
    // degrades to slow-but-correct rather than breaking the arm.
    console.error('[/api/prove] PROVING_RELAYER_URL is not set — no server-side prover configured');
    return NextResponse.json(
      { error: 'Proving relayer is not configured (set PROVING_RELAYER_URL)' },
      { status: 503 },
    );
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (RELAYER_API_TOKEN) headers['X-API-TOKEN'] = RELAYER_API_TOKEN;

  // Forward the exact authenticated body (already validated size/circuit).
  const forwarded = JSON.stringify({ inputs, circuit });

  try {
    const upstream = await fetch(`${PROVING_RELAYER_URL}/prove`, {
      method: 'POST',
      headers,
      body: forwarded,
      signal: AbortSignal.timeout(RELAYER_TIMEOUT_MS),
    });
    const payload = await upstream.json().catch(() => ({ error: 'Relayer returned a non-JSON response' }));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (err) {
    // Never surface upstream URLs or tokens to the browser.
    console.error('[/api/prove]', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Proof generation failed' }, { status: 502 });
  }
}

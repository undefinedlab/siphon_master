import { NextRequest, NextResponse } from 'next/server';
import { getRpcBenchmarkSnapshot, resetRpcBenchmark } from '@/lib/rpcBenchmark';
import { authorizeRpcStats } from '@/lib/rpcHttpGuard';

export const runtime = 'nodejs';

/** GET /api/rpc/stats — in-memory RPC benchmark counters (dev / diagnostics). */
export async function GET(req: NextRequest) {
  const locked = authorizeRpcStats();
  if (!locked.ok) return locked.response;

  const reset = req.nextUrl.searchParams.get('reset') === '1';
  if (reset) resetRpcBenchmark();
  const snap = getRpcBenchmarkSnapshot();
  const uptimeSec = Math.round((Date.now() - snap.startedAt) / 1000);
  const methods = Object.entries(snap.byMethod)
    .map(([method, s]) => ({
      method,
      count: s.count,
      avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
      errors: s.errors,
      lastAt: s.lastAt,
    }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    uptimeSec,
    totalRequests: snap.totalRequests,
    totalDurationMs: snap.totalDurationMs,
    avgMs: snap.totalRequests
      ? Math.round(snap.totalDurationMs / snap.totalRequests)
      : 0,
    byChainId: snap.byChainId,
    methods,
    recent: snap.recent.slice(-50),
  });
}

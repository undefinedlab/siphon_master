/** In-memory RPC traffic stats for /api/rpc benchmarking (resets on cold deploy). */

export type RpcMethodStats = {
  count: number;
  totalMs: number;
  errors: number;
  lastAt: number;
};

export type RpcBenchmarkSnapshot = {
  startedAt: number;
  totalRequests: number;
  totalDurationMs: number;
  byMethod: Record<string, RpcMethodStats>;
  byChainId: Record<string, number>;
  recent: RpcRecentEntry[];
};

export type RpcRecentEntry = {
  at: number;
  chainId: number;
  method: string;
  durationMs: number;
  ok: boolean;
  referer?: string;
  userAgent?: string;
};

const MAX_RECENT = 200;

const state: RpcBenchmarkSnapshot = {
  startedAt: Date.now(),
  totalRequests: 0,
  totalDurationMs: 0,
  byMethod: {},
  byChainId: {},
  recent: [],
};

function parseRpcMethods(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const methods: string[] = [];
    for (const item of items) {
      if (item && typeof item === "object" && "method" in item) {
        const m = (item as { method?: unknown }).method;
        if (typeof m === "string") methods.push(m);
      }
    }
    return methods.length > 0 ? methods : ["<unknown>"];
  } catch {
    return ["<parse-error>"];
  }
}

export function recordRpcRequest(input: {
  chainId: number;
  body: string;
  durationMs: number;
  ok: boolean;
  referer?: string | null;
  userAgent?: string | null;
}) {
  const methods = parseRpcMethods(input.body);
  state.totalRequests += 1;
  state.totalDurationMs += input.durationMs;
  state.byChainId[String(input.chainId)] =
    (state.byChainId[String(input.chainId)] ?? 0) + 1;

  for (const method of methods) {
    const hit = state.byMethod[method] ?? {
      count: 0,
      totalMs: 0,
      errors: 0,
      lastAt: 0,
    };
    hit.count += 1;
    hit.totalMs += input.durationMs;
    if (!input.ok) hit.errors += 1;
    hit.lastAt = Date.now();
    state.byMethod[method] = hit;

    state.recent.push({
      at: Date.now(),
      chainId: input.chainId,
      method,
      durationMs: input.durationMs,
      ok: input.ok,
      referer: input.referer ?? undefined,
      userAgent: input.userAgent ?? undefined,
    });
  }

  if (state.recent.length > MAX_RECENT) {
    state.recent.splice(0, state.recent.length - MAX_RECENT);
  }
}

export function getRpcBenchmarkSnapshot(): RpcBenchmarkSnapshot {
  return {
    ...state,
    byMethod: { ...state.byMethod },
    byChainId: { ...state.byChainId },
    recent: [...state.recent],
  };
}

export function resetRpcBenchmark() {
  state.startedAt = Date.now();
  state.totalRequests = 0;
  state.totalDurationMs = 0;
  state.byMethod = {};
  state.byChainId = {};
  state.recent = [];
}

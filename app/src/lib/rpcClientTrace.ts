"use client";

/** Client-side RPC call tracing — enable with NEXT_PUBLIC_RPC_TRACE=1 in .env.local */

type RpcClientEntry = {
  at: number;
  method: string;
  durationMs: number;
  ok: boolean;
  source?: string;
};

const MAX = 300;
const entries: RpcClientEntry[] = [];
const listeners = new Set<() => void>();

const ENABLED =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_RPC_TRACE === "1";

export function isRpcClientTraceEnabled(): boolean {
  return ENABLED;
}

export function recordRpcClientCall(entry: Omit<RpcClientEntry, "at">) {
  if (!ENABLED) return;
  entries.push({ ...entry, at: Date.now() });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  listeners.forEach((fn) => fn());
}

export function getRpcClientTrace(): RpcClientEntry[] {
  return [...entries];
}

export function clearRpcClientTrace() {
  entries.length = 0;
  listeners.forEach((fn) => fn());
}

export function subscribeRpcClientTrace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Patch ethers JsonRpcProvider to log every outbound JSON-RPC call. */
export function installRpcClientTracer(
  provider: { send: (method: string, params: unknown[]) => Promise<unknown> },
  source = "JsonRpcProvider",
) {
  if (!ENABLED) return;
  const orig = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[]) => {
    const t0 = performance.now();
    try {
      const result = await orig(method, params);
      recordRpcClientCall({
        method,
        durationMs: Math.round(performance.now() - t0),
        ok: true,
        source,
      });
      return result;
    } catch (err) {
      recordRpcClientCall({
        method,
        durationMs: Math.round(performance.now() - t0),
        ok: false,
        source,
      });
      throw err;
    }
  };
}

if (typeof window !== "undefined" && ENABLED) {
  (window as Window & { __siphonRpcTrace?: typeof getRpcClientTrace }).__siphonRpcTrace =
    getRpcClientTrace;
}

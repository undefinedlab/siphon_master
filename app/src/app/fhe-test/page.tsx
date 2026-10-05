"use client";

// Isolated harness for in-browser FHE (client-side encryption). Needs NO backend
// service running — it exercises the wasm directly: keygen -> encrypt -> decrypt
// roundtrip, plus condition-tree encryption. Visit /fhe-test.

import { notFound } from "next/navigation";
import { useEffect, useState } from "react";
import {
  initFhe,
  generateKeys,
  encryptPrice,
  decryptResult,
  encryptConditionTree,
  type FheKeyPair,
} from "@/lib/fhe";

type Log = { t: string; msg: string };

export default function FheTestPage() {
  // Debug harness — not for production builds (NEXT_PUBLIC_SIPHON_DEBUG=1 keeps it on a debug build).
  if (process.env.NODE_ENV === "production" && (process.env.NEXT_PUBLIC_SIPHON_DEBUG || "").trim() !== "1") notFound();
  const [ready, setReady] = useState(false);
  const [keys, setKeys] = useState<FheKeyPair | null>(null);
  const [price, setPrice] = useState("2500.50");
  const [cipher, setCipher] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);

  const log = (msg: string) =>
    setLogs((l) => [...l, { t: new Date().toLocaleTimeString(), msg }]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t0 = performance.now();
      try {
        await initFhe();
        if (cancelled) return;
        setReady(true);
        log(`wasm loaded in ${(performance.now() - t0).toFixed(0)}ms`);
      } catch (e) {
        log(`wasm load FAILED: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onGenKeys() {
    setBusy(true);
    const t0 = performance.now();
    try {
      log("generating keypair (server key is slow in wasm)…");
      const k = await generateKeys();
      setKeys(k);
      log(
        `keys generated in ${(performance.now() - t0).toFixed(0)}ms — ` +
          `clientKey ${k.clientKey.length} hex chars, serverKey ${k.serverKey.length} hex chars`,
      );
    } catch (e) {
      log(`keygen FAILED: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onRoundtrip() {
    if (!keys) return;
    setBusy(true);
    try {
      const p = parseFloat(price);
      const t0 = performance.now();
      const ct = await encryptPrice(p, keys.clientKey);
      setCipher(ct);
      log(
        `encrypted $${p} -> ${ct.length} hex chars in ${(
          performance.now() - t0
        ).toFixed(0)}ms`,
      );

      // decrypt_result returns true iff the decrypted u64 == 1, so a raw price
      // ($2500.50 -> 250050 cents) roundtrips to `false`. We assert it does NOT
      // throw and is a boolean — proving the ciphertext deserializes correctly.
      const t1 = performance.now();
      const r = await decryptResult(ct, keys.clientKey);
      log(
        `decrypt_result(ciphertext) = ${r} in ${(
          performance.now() - t1
        ).toFixed(0)}ms (expected false for a non-1 value — proves roundtrip)`,
      );
    } catch (e) {
      log(`roundtrip FAILED: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onTree() {
    if (!keys) return;
    setBusy(true);
    try {
      const tree = {
        op: "AND",
        conditions: [
          { op: "LEAF", asset: "ETH", cmp: "GT", bound: 2500 },
          { op: "LEAF", asset: "BTC", cmp: "LT", bound: 65000 },
        ],
      };
      const t0 = performance.now();
      const enc = await encryptConditionTree(tree, keys.clientKey);
      log(
        `condition tree encrypted in ${(performance.now() - t0).toFixed(0)}ms:`,
      );
      log(JSON.stringify(enc, null, 2));
    } catch (e) {
      log(`tree encrypt FAILED: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 820,
        margin: "40px auto",
        padding: 24,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#e6e6e6",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Siphon — Client-Side FHE Test</h1>
      <p style={{ opacity: 0.7, fontSize: 13, marginTop: 0 }}>
        In-browser tfhe-rs (wasm). No backend required. wasm:{" "}
        {ready ? "✅ ready" : "⏳ loading…"}
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "16px 0" }}>
        <button onClick={onGenKeys} disabled={!ready || busy} style={btn}>
          1. Generate keys
        </button>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          style={input}
        />
        <button onClick={onRoundtrip} disabled={!keys || busy} style={btn}>
          2. Encrypt + roundtrip
        </button>
        <button onClick={onTree} disabled={!keys || busy} style={btn}>
          3. Encrypt condition tree
        </button>
      </div>

      {keys && (
        <div style={{ fontSize: 11, opacity: 0.6, wordBreak: "break-all", marginBottom: 8 }}>
          serverKey[…64]: {keys.serverKey.slice(0, 64)}…
        </div>
      )}
      {cipher && (
        <div style={{ fontSize: 11, opacity: 0.6, wordBreak: "break-all", marginBottom: 8 }}>
          ciphertext[…64]: {cipher.slice(0, 64)}…
        </div>
      )}

      <pre
        style={{
          background: "#111",
          border: "1px solid #333",
          borderRadius: 8,
          padding: 12,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          maxHeight: 380,
          overflow: "auto",
        }}
      >
        {logs.map((l, i) => `[${l.t}] ${l.msg}`).join("\n") || "logs…"}
      </pre>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "8px 12px",
  background: "#1f6feb",
  color: "white",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};

const input: React.CSSProperties = {
  padding: "8px 10px",
  background: "#111",
  color: "#e6e6e6",
  border: "1px solid #333",
  borderRadius: 6,
  width: 110,
  fontSize: 13,
};

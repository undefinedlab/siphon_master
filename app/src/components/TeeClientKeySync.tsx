"use client";

/**
 * When TEE autonomous mode is on, sync an existing local client key to the confidential VM
 * on wallet connect (so returning users don't need to re-submit a strategy).
 */

import { useEffect } from "react";
import { getStoredClientKey, generateKeys, encryptPriceCents } from "@/lib/fhe";
import { ensureClientKeyInDecryptor, isTeeAutonomousMode } from "@/lib/decryptorClient";
import { ensureServerKeyUploaded, warmFheKeys, retryFheKeyUpload, getFheKeyState } from "@/lib/fheKeyWarmup";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { resolveWalletAddress } from "@/lib/walletAddress";
import { readStoredHomeChainId, resolveHomeChainOption } from "@/lib/chains/homeChains";
import { walletManager } from "@/components/extensions/walletManager";
import { isUserRejection } from "@/lib/walletRejection";
import { isSignatureDeclined } from "@/lib/walletSignatureGate";

export default function TeeClientKeySync() {
  // DEV-only console hooks — never register in production (XSS could trigger key resync / exfil paths).
  useEffect(() => {
    const debugOn =
      process.env.NODE_ENV === "development" ||
      (process.env.NEXT_PUBLIC_SIPHON_DEBUG || "").trim() === "1";
    if (!debugOn) return;

    // Manual resync — re-derive + re-upload server/client keys. `await window.__siphonResync()`
    (window as unknown as { __siphonResync?: () => Promise<string> }).__siphonResync = async () => {
      const userId = resolveWalletAddress();
      if (!userId) return "no wallet connected";
      const clientKey = getStoredClientKey(userId);
      if (!clientKey) return "no stored client key for " + userId;
      await ensureServerKeyUploaded(userId, clientKey);
      await ensureClientKeyInDecryptor(userId, clientKey);
      return "resynced server+client key for " + userId.toLowerCase();
    };

    // Arm pre-proof dry run without arming fee. `await window.__siphonArmDryRun()`
    (window as unknown as {
      __siphonArmDryRun?: (o?: {
        amountHuman?: string;
        outSymbol?: string;
        ethUsdPrice?: number;
      }) => Promise<unknown>;
    }).__siphonArmDryRun = async (o) => {
      const { armSameChainVaultSwap } = await import("@/lib/atomicVaultSwap");
      const { getSelectedChainId, getTokens } = await import("@/lib/networks");
      const { fetchCoinPrices } = await import("@/components/navs/Discover/price_utils");
      const chainId = getSelectedChainId();
      const tokens = getTokens(chainId);
      const inToken = tokens.ETH;
      const outToken = tokens[(o?.outSymbol || "USDC").toUpperCase()] ?? tokens.USDC;
      const prices = await fetchCoinPrices().catch(() => ({}) as Record<string, number>);
      const ethUsdPrice = o?.ethUsdPrice ?? Number(prices.ETH ?? prices.eth ?? 0);
      if (!ethUsdPrice) return { error: "could not fetch ETH/USD — pass { ethUsdPrice }" };
      console.log(`[ARM-TRACE] dry run: no arming fee charged; ethUsd=${ethUsdPrice}`);
      const started = Date.now();
      const r = await armSameChainVaultSwap({
        chainId,
        inToken,
        outToken,
        amountHuman: o?.amountHuman || "0.01",
        ethUsdPrice,
        maxSlippageBps: 100,
      });
      console.log(`[ARM-TRACE] dry run finished in ${Date.now() - started}ms`, r);
      return r;
    };

    // FHE self-test against local executor debugEval — never runs in production builds.
    (window as unknown as { __siphonFheSelfTest?: () => Promise<unknown> }).__siphonFheSelfTest = async () => {
      const { clientKey, serverKey } = await generateKeys();
      const ct0 = await encryptPriceCents(0n, clientKey);
      const r = await fetch("http://localhost:5005/debugEval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_key: serverKey,
          client_key: clientKey,
          encrypted_lower_bound: ct0,
          current_time: 100,
        }),
      });
      const j = await r.json();
      console.log("[FHE SELF-TEST]", j);
      return j;
    };

    // Adopt a strategy's swap proceeds that were armed before the output-note stash existed.
    // Those fills minted a real on-chain note the UI cannot see, because arming recorded only a
    // precommitment — no amount, label or asset — so nothing could rebuild the commitment.
    //   await window.__siphonAdoptOutputNote(11155111, "2486642", "USDC")
    // valueWei comes from the fill's SwapUserDestNote(token, minOut, commitment) event: the kernel
    // mints the user note at exactly minOut, NOT at what the pool paid.
    (window as unknown as {
      __siphonAdoptOutputNote?: (chainId: number, valueWei: string, symbol: string) => Promise<string>;
    }).__siphonAdoptOutputNote = async (chainId, valueWei, symbol) => {
      const { getSigner } = await import("@/lib/nexus");
      const signer = getSigner();
      if (!signer) return "no wallet connected";
      const { getTokens } = await import("@/lib/networks");
      const token = getTokens(chainId)[symbol.toUpperCase()];
      if (!token) return `unknown token ${symbol} on chain ${chainId}`;
      const { noteAssetIdFor } = await import("@/lib/v3/noteCryptoV3");
      const { adoptOrphanOutputNote } = await import("@/lib/v3/outputNoteResolverV3");
      const commitment = await adoptOrphanOutputNote(chainId, signer, {
        valueWei,
        assetId: noteAssetIdFor(chainId, token.address).toString(),
        symbol: symbol.toUpperCase(),
      });
      return commitment
        ? `adopted ${symbol.toUpperCase()} note ${commitment} — refresh the dashboard`
        : "no pending precommitment matched; check valueWei against the SwapUserDestNote event";
    };

    return () => {
      try {
        delete (window as unknown as { __siphonAdoptOutputNote?: unknown }).__siphonAdoptOutputNote;
        delete (window as unknown as { __siphonResync?: unknown }).__siphonResync;
        delete (window as unknown as { __siphonArmDryRun?: unknown }).__siphonArmDryRun;
        delete (window as unknown as { __siphonFheSelfTest?: unknown }).__siphonFheSelfTest;
      } catch {
        /* ignore */
      }
    };
  }, []);

  // FHE key warmup + soft privileged session: local FHE keys (no write popup on connect),
  // then one Siphon auth v1:session sign covering dash ASP polls + builder for ~5m.
  useEffect(() => {
    const warm = (): boolean => {
      // Not while the welcome guide is up. This component renders alongside <Nexus> on the dapp
      // page, so it mounts even though the onboarding overlay is what the user is looking at —
      // and warmFheKeys derives the FHE seed, which is a WALLET SIGNATURE. Returning false keeps
      // the caller's poll alive, so warming starts as soon as the guide is dismissed.
      if (!hasCompletedOnboarding()) return false;

      // Same gate as the session prime: no signature until a home chain is chosen, and a Solana
      // Devnet home signs with Phantom — not the EVM wallet MetaMask already reconnected.
      const home = resolveHomeChainOption(readStoredHomeChainId());
      if (!home) return false;
      const solanaHome = home.kind === "solana" || home.productChainId === "solana-devnet";
      const userId = solanaHome
        ? walletManager.getWallet("solana")?.address ?? null
        : resolveWalletAddress();
      if (!userId) return false;
      void (async () => {
        try {
          await warmFheKeys(userId); // local only — upload deferred to arm
        } catch {
          /* logged inside */
        }
        if (solanaHome) return;
        try {
          const { getSigner } = await import("@/lib/nexus");
          const { getWalletAuthHeaders, hasSessionKey } = await import("@/lib/walletAuthHeaders");
          const signer = getSigner();
          if (!signer) return;
          // Only warm read-auth once a session key exists. getWalletAuthHeaders prefers the
          // session and falls back to a WALLET signature when there is none — and this runs on
          // mount, so warming it during the bootstrap's race window opened a MetaMask prompt for
          // something the user never clicked. Skipping is free: each path primes on first use.
          if (!(await hasSessionKey(signer))) return;
          await getWalletAuthHeaders(signer);
          // No ensurePrivilegedSession() here any more. Privileged sessions became PATH-SCOPED:
          // the cache key and the signed message both carry the pathname, so a session signed for
          // one endpoint is not valid for another. A path-less global warm-up no longer exists as
          // a concept — priming would mean picking one endpoint, warming only that one, and
          // charging the user a signature prompt at connect time for a path they may never call.
          // The fallback the old catch already described is now simply the behaviour: each path
          // primes on its first privileged call.
        } catch {
          /* auth headers prime on first authenticated call instead */
        }
      })();
      return true;
    };

    // MetaMask auto-reconnect can land after mount without firing walletConnected — poll
    // briefly until an address shows up, then stop.
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    if (!warm()) {
      timer = setInterval(() => { if (warm()) stop(); }, 2000);
      // 10 minutes, not 2: this poll now also waits out the onboarding guide, and 120s of reading
      // would expire it — leaving the FHE keys unwarmed with no prompt and no retry until reload.
      setTimeout(stop, 10 * 60_000);
    }
    // Retry failed executor upload (e.g. env URL changed mid-session or transient network blip).
    const retryUpload = (): void => {
      const userId = resolveWalletAddress();
      if (!userId) return;
      const st = getFheKeyState();
      if (st.userId === userId.toLowerCase() && st.stage === "error" && st.serverKeyReady) {
        void retryFheKeyUpload(userId).catch(() => {/* logged inside */});
      }
    };
    const retryTimer = setInterval(retryUpload, 30_000);
    window.addEventListener("walletConnected", warm);
    return () => {
      stop();
      clearInterval(retryTimer);
      window.removeEventListener("walletConnected", warm);
    };
  }, []);

  useEffect(() => {
    if (!isTeeAutonomousMode()) return;

    let done = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // The tick is async and the interval is 3s. A sync that takes longer — TEE attestation, a slow
    // uploadClientKey — let the NEXT tick start alongside it, so requests (and, before write auth
    // moved to the session key, wallet prompts) queued up. One at a time.
    let inFlight = false;
    // Bounds the "session key not ready" case: ~10 ticks ≈ 30s, well past the 2s bootstrap poll.
    let noSessionTicks = 0;
    const MAX_NO_SESSION_TICKS = 10;

    // "synced"  — done, stop the timer.
    // "retry"   — transient (network blip, enclave restarting); keep polling.
    // "declined"— the user rejected the wallet prompt; stop, or we re-prompt every 3s.
    //
    // The decline case is new and load-bearing. Before wrapped storage this tick early-returned
    // on every fresh tab because getStoredClientKey was null; now it is non-null, so each tick
    // reaches ensureClientKeyInDecryptor. Its non-force guard needs `uploadedFp` from
    // localStorage, which is absent in exactly this change's headline scenario (new device,
    // server restore) — so it calls getWalletWriteAuthHeaders, a raw signWithDeadline that also
    // CLEARS the read-auth decline latch. A swallowed rejection would therefore re-prompt every
    // 3s for the full 120s window: ~40 prompts. Latch on rejection only, so a network blip stays
    // retryable — the same one-attempt-per-load discipline WalletSessionBootstrap already uses.
    const sync = async (): Promise<"synced" | "retry" | "declined"> => {
      const userId = resolveWalletAddress();
      if (!userId) return "retry"; // wallet not connected yet — keep polling
      const clientKey = getStoredClientKey(userId);
      if (!clientKey) return "retry"; // no key for this wallet yet (e.g. before first strategy)
      try {
        await ensureClientKeyInDecryptor(userId, clientKey);
        console.log("[TEE] Key secured in the attested enclave");
        return "synced";
      } catch (e) {
        if (isUserRejection(e) || isSignatureDeclined(e)) {
          console.warn("[TEE] Client key sync declined — not re-prompting this page load.");
          return "declined";
        }
        // A missing session key is not a failure to log 40 times. The bootstrap mints one within
        // a couple of seconds of connect, so a few ticks are expected — but if it never arrives
        // (the user declined it), retrying every 3s for the full 120s window just spams the
        // console. sessionKey.ts does not record declines, so bound it here instead.
        const { isSessionKeyRequired } = await import("@/lib/walletAuthHeaders");
        if (isSessionKeyRequired(e)) {
          noSessionTicks += 1;
          if (noSessionTicks >= MAX_NO_SESSION_TICKS) {
            console.warn("[TEE] No session key after ~30s — stopping client key sync.");
            return "declined";
          }
          return "retry";
        }
        console.warn("[TEE] Client key sync failed (will retry):", e);
        return "retry";
      }
    };

    // MetaMask auto-reconnect can land after mount and won't always fire walletConnected,
    // and the decryptor (in-memory keys) may have restarted — so poll until the key is synced.
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const tick = async () => {
      if (done || inFlight) return;
      inFlight = true;
      try {
        if ((await sync()) !== "retry") { done = true; stop(); }
      } finally {
        inFlight = false;
      }
    };

    void tick();
    timer = setInterval(tick, 3000); // retry every 3s
    // Stop polling after ~2 min so we don't loop forever if the user never connects.
    const giveUp = setTimeout(stop, 120_000);
    window.addEventListener("walletConnected", tick);
    return () => {
      stop();
      clearTimeout(giveUp);
      window.removeEventListener("walletConnected", tick);
    };
  }, []);

  return null;
}

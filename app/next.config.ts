import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaderEntries } from "./src/lib/botProtection";
import webpack from "webpack";

const appDir = process.cwd();
const zodMiniShim = path.resolve(appDir, "src/lib/wagmi/zod-mini-shim.js");
const portoInternalShim = path.resolve(appDir, "src/lib/wagmi/porto-internal-shim.js");
const portoConnectorStub = path.resolve(appDir, "src/lib/wagmi/porto-connector-stub.js");

const nextConfig: NextConfig = {
  output: "standalone",

  // `next dev --turbopack` ignores the webpack() hook below.
  turbopack: {
    resolveAlias: {
      "zod/mini": "./src/lib/wagmi/zod-mini-shim.js",
      "porto/internal": "./src/lib/wagmi/porto-internal-shim.js",
    },
  },

  // Keep the live development compiler isolated from `next build`, which replaces `.next`.
  // Running a production verification build must never delete routes/assets used by localhost.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // snarkjs is ~300MB — never bundle it into server functions.
  // /api/prove shells out to rapidsnark instead; snarkjs only runs in the browser.
  serverExternalPackages: ["snarkjs", "ffjavascript", "circomlibjs", "@iden3/binfileutils"],

  // Standalone NFT otherwise walks huge client-only trees and OOMs/times out on Railway.
  // Keep snarkjs out of the global NFT (large); pipeline-prove pulls it via Dockerfile + Includes.
  outputFileTracingExcludes: {
    "*": [
      "node_modules/snarkjs/**/*",
      "node_modules/ffjavascript/**/*",
      "node_modules/three/**/*",
      "node_modules/@arcium-hq/**/*",
      "node_modules/html2canvas/**/*",
      "node_modules/html2canvas-pro/**/*",
      "node_modules/jspdf/**/*",
      "node_modules/lightweight-charts/**/*",
      "node_modules/recharts/**/*",
      "node_modules/@xyflow/**/*",
      "node_modules/@react-three/**/*",
      "node_modules/@wormhole-foundation/**/*",
      "node_modules/@zkmelabs/**/*",
      "node_modules/@solflare-wallet/**/*",
      "node_modules/@sentry/**/*",
      "node_modules/@rainbow-me/**/*",
      "node_modules/@walletconnect/**/*",
      "node_modules/supabase/**/*",
      "node_modules/typescript/**/*",
      "node_modules/@types/**/*",
      "node_modules/eslint/**/*",
      "node_modules/eslint-config-next/**/*",
      "node_modules/@tailwindcss/**/*",
      "node_modules/tailwindcss/**/*",
      "fhe-wasm/target/**/*",
      "public/zk/**/*",
    ],
  },
  // WalletConnect / Solana RPC pull `ws` at runtime; NFT often misses it.
  // pipeline-prove: dynamic import("circomlibjs"/"snarkjs") is invisible to NFT — pin them.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/ws/**/*"],
    "/dapp": ["./node_modules/ws/**/*"],
    "/dapp/*": ["./node_modules/ws/**/*"],
    "/api/solana/pipeline-prove": [
      "./node_modules/circomlibjs/**/*",
      "./node_modules/wasmcurves/**/*",
      "./node_modules/ffjavascript/**/*",
      "./node_modules/@iden3/**/*",
      "./node_modules/snarkjs/**/*",
      "./node_modules/r1csfile/**/*",
      "./node_modules/fastfile/**/*",
      "./node_modules/circom_runtime/**/*",
    ],
  },

  // Fail closed on lint/type errors when STRICT_BUILD=1 (recommended in CI).
  // Default remains permissive so emergency deploys are not blocked by pre-existing debt —
  // set STRICT_BUILD=1 locally/`bun run build:strict` to catch regressions.
  eslint: { ignoreDuringBuilds: process.env.STRICT_BUILD !== "1" },
  typescript: { ignoreBuildErrors: process.env.STRICT_BUILD !== "1" },
  async headers() {
    return [
      // Public ZK artifacts are not private; allow long-lived CDN/browser cache (zkeys/wasm/vk).
      {
        source: "/zk/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/:path*",
        // Static headers only — CSP/Report-To come from middleware (avoids duplicate Report-To on /_next HMR chunks).
        headers: securityHeaderEntries(),
      },
    ];
  },
  // The old siphon.money/solana entry point. Solana now lives in the one app (home-chain picker /
  // DEVNET toggle); keep shared links working instead of 404ing.
  async redirects() {
    return [{ source: "/solana/:path*", destination: "/", permanent: true }];
  },
  async rewrites() {
    // Serve the receipt verification page under the branded app domain instead of the raw
    // executor host (…sslip.io). The QR points at siphon.money/verify/…; Next proxies it to the
    // order-signer/executor, which does the actual TEE digest + signature recovery.
    const executor = (
      process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL ||
      process.env.TRADE_EXECUTOR_URL ||
      ""
    ).replace(/\/+$/, "");
    const prod =
      (process.env.VERCEL_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
    if (!executor) {
      if (prod) {
        console.warn(
          "[next.config] NEXT_PUBLIC_TRADE_EXECUTOR_URL unset in production — /verify and /receipt rewrites disabled",
        );
      }
      return [];
    }
    return [
      // Narrow rewrite targets — middleware also rejects .. / odd paths (PROXY-05).
      { source: "/verify/:slug", destination: `${executor}/verify/:slug` },
      { source: "/verify/:slug/:rest", destination: `${executor}/verify/:slug/:rest` },
      { source: "/receipt/verify", destination: `${executor}/receipt/verify` },
      { source: "/receipt/:slug", destination: `${executor}/receipt/:slug` },
      { source: "/receipt/:slug/:rest", destination: `${executor}/receipt/:slug/:rest` },
    ];
  },
  webpack: (config) => {
    // Required to import the wasm-bindgen (bundler target) FHE module in fhe-wasm/pkg.
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      topLevelAwait: true,
    };
    // libsodium-wrappers' ESM entry imports "./libsodium.mjs", a file the package doesn't
    // ship — force the (self-contained) CJS build instead. Must be an absolute file path:
    // a bare subpath alias is rejected by the package's `exports` field.
    // Used by decryptorAttestation.ts.
    config.resolve = {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        // Optional wagmi connector — Siphon uses MetaMask/Coinbase/injected only.
        // Local re-export, so this specifier does not depend on Zod's export conditions.
        "zod/mini": zodMiniShim,
        "porto/internal": portoInternalShim,
        // Keep @wagmi/connectors from pulling porto → zod/mini into the client graph.
        "@wagmi/connectors/porto": portoConnectorStub,
        "libsodium-wrappers": path.resolve(
          process.cwd(),
          "node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js",
        ),
        "libsodium": path.resolve(
          process.cwd(),
          "node_modules/libsodium/dist/modules/libsodium.js",
        ),
      },
      fallback: {
        ...config.resolve?.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        // Optional deps pulled in by wagmi/RainbowKit's connectors (MetaMask SDK's React Native
        // storage backend, WalletConnect's pino logger's pretty-printer) — never used in-browser.
        "@react-native-async-storage/async-storage": false,
        "pino-pretty": false,
      },
    };
    // node: protocol imports (node:fs, node:path, etc.) are NOT handled by fallback — they
    // need a replacement plugin. Replace them with empty modules for browser bundles.
    config.plugins = [
      ...(config.plugins ?? []),
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
        resource.request = resource.request.replace(/^node:/, '');
      }),
      // App-router layers replace resolve.alias, so the mapping above is not
      // visible to every import of `zod/mini` / `porto/internal`.
      new webpack.NormalModuleReplacementPlugin(/^zod\/mini$/, (resource: { request: string }) => {
        resource.request = zodMiniShim;
      }),
      new webpack.NormalModuleReplacementPlugin(/^porto\/internal$/, (resource: { request: string }) => {
        resource.request = portoInternalShim;
      }),
      new webpack.NormalModuleReplacementPlugin(
        /[\\/]@wagmi[\\/]connectors[\\/].*[\\/]porto\.js$/,
        portoConnectorStub,
      ),
    ];
    // asyncWebAssembly emits async/await to instantiate the wasm. Webpack otherwise
    // conservatively assumes the target may not support async functions and warns it
    // "may cause runtime errors". Modern browsers do support it — declare that so the
    // warning goes away and webpack doesn't try to down-level the async wasm loader.
    config.output = {
      ...config.output,
      environment: {
        ...config.output?.environment,
        asyncFunction: true,
      },
    };
    return config;
  },
};

export default nextConfig;

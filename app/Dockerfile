# Next.js 15 standalone for Railway. ZK artifacts stay on CDN via NEXT_PUBLIC_ZK_BASE_URL.
# Build-args for NEXT_PUBLIC_* are inlined at build time (same as Amplify).

FROM oven/bun:1.3.14-debian AS deps
WORKDIR /app
COPY package.json bun.lock .bun-version ./
# Ignore lifecycle scripts here — source (and stub script) is not in the deps layer yet.
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3.14-debian AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# @wagmi/connectors barrel-exports Porto, which pulls porto/internal → zod/mini.
# Webpack cannot resolve encode/decode through those re-exports; Siphon never uses Porto.
RUN cp src/lib/wagmi/porto-connector-stub.js \
      node_modules/@wagmi/connectors/dist/esm/porto.js

# Railway's upload filter drops *.wasm (even when tracked). Ship a .wasm.bin
# sidecar and restore the expected filename before Next.js resolves the import.
RUN if [ ! -f fhe-wasm/pkg/siphon_fhe_wasm_bg.wasm ] \
      && [ -f fhe-wasm/pkg/siphon_fhe_wasm_bg.wasm.bin ]; then \
      cp fhe-wasm/pkg/siphon_fhe_wasm_bg.wasm.bin fhe-wasm/pkg/siphon_fhe_wasm_bg.wasm; \
    fi \
 && test -f fhe-wasm/pkg/siphon_fhe_wasm_bg.wasm \
  || (echo "missing fhe-wasm/pkg/siphon_fhe_wasm_bg.wasm(.bin) in build context" >&2; ls -la fhe-wasm/pkg || true; exit 1)

# Keep public/zk out of the image when CDN URL is set (matches amplify.yml).
ARG NEXT_PUBLIC_ZK_BASE_URL
ENV NEXT_PUBLIC_ZK_BASE_URL=$NEXT_PUBLIC_ZK_BASE_URL
RUN if [ -n "$NEXT_PUBLIC_ZK_BASE_URL" ]; then rm -rf public/zk; fi

# Client-inlined public env (pass as --build-arg / Railway variables at build).
# Mock TEE defaults: sealed ClientKey + server-side fire. Do not ARG plaintext ClientKey.
ARG NEXT_PUBLIC_ALLOW_MOCK_TEE=true
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_DECRYPTOR_MEASUREMENT
ARG NEXT_PUBLIC_TEE_AUTONOMOUS=true
ARG NEXT_PUBLIC_TRADE_EXECUTOR_URL
ARG NEXT_PUBLIC_SOLANA_DEVNET_EXECUTOR_URL
ARG NEXT_PUBLIC_API_GATEWAY_URL
ARG NEXT_PUBLIC_ASP_URL
ARG NEXT_PUBLIC_SOLASP_URL
ARG NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID
ARG NEXT_PUBLIC_SIPHON_SOLANA_ZK=1
ARG NEXT_PUBLIC_SOLANA_RPC_URL
ARG NEXT_PUBLIC_SOLANA_USDC_MINT
ARG NEXT_PUBLIC_METEORA_POOL
ARG NEXT_PUBLIC_METEORA_JLUSDC_SOL_POOL
ARG NEXT_PUBLIC_METEORA_JITOSOL_SOL_POOL
ARG NEXT_PUBLIC_JITO_SOL_MINT
ARG NEXT_PUBLIC_JITO_STAKE_POOL
ARG NEXT_PUBLIC_JUPITER_JL_USDC_MINT
ARG NEXT_PUBLIC_SOLANA_SETTLEMENT_PUBKEY
ARG NEXT_PUBLIC_SOLANA_ASP_SCREEN=1

ENV NEXT_PUBLIC_ALLOW_MOCK_TEE=$NEXT_PUBLIC_ALLOW_MOCK_TEE \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_DECRYPTOR_MEASUREMENT=$NEXT_PUBLIC_DECRYPTOR_MEASUREMENT \
    NEXT_PUBLIC_TEE_AUTONOMOUS=$NEXT_PUBLIC_TEE_AUTONOMOUS \
    NEXT_PUBLIC_TRADE_EXECUTOR_URL=$NEXT_PUBLIC_TRADE_EXECUTOR_URL \
    NEXT_PUBLIC_SOLANA_DEVNET_EXECUTOR_URL=$NEXT_PUBLIC_SOLANA_DEVNET_EXECUTOR_URL \
    NEXT_PUBLIC_API_GATEWAY_URL=$NEXT_PUBLIC_API_GATEWAY_URL \
    NEXT_PUBLIC_ASP_URL=$NEXT_PUBLIC_ASP_URL \
    NEXT_PUBLIC_SOLASP_URL=$NEXT_PUBLIC_SOLASP_URL \
    NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID=$NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID \
    NEXT_PUBLIC_SIPHON_SOLANA_ZK=$NEXT_PUBLIC_SIPHON_SOLANA_ZK \
    NEXT_PUBLIC_SOLANA_RPC_URL=$NEXT_PUBLIC_SOLANA_RPC_URL \
    NEXT_PUBLIC_SOLANA_USDC_MINT=$NEXT_PUBLIC_SOLANA_USDC_MINT \
    NEXT_PUBLIC_METEORA_POOL=$NEXT_PUBLIC_METEORA_POOL \
    NEXT_PUBLIC_METEORA_JLUSDC_SOL_POOL=$NEXT_PUBLIC_METEORA_JLUSDC_SOL_POOL \
    NEXT_PUBLIC_METEORA_JITOSOL_SOL_POOL=$NEXT_PUBLIC_METEORA_JITOSOL_SOL_POOL \
    NEXT_PUBLIC_JITO_SOL_MINT=$NEXT_PUBLIC_JITO_SOL_MINT \
    NEXT_PUBLIC_JITO_STAKE_POOL=$NEXT_PUBLIC_JITO_STAKE_POOL \
    NEXT_PUBLIC_JUPITER_JL_USDC_MINT=$NEXT_PUBLIC_JUPITER_JL_USDC_MINT \
    NEXT_PUBLIC_SOLANA_SETTLEMENT_PUBKEY=$NEXT_PUBLIC_SOLANA_SETTLEMENT_PUBKEY \
    NEXT_PUBLIC_SOLANA_ASP_SCREEN=$NEXT_PUBLIC_SOLANA_ASP_SCREEN \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=12288

# Typecheck first so OOM during NFT still leaves a clear compile signal in logs.
RUN bun run typecheck
RUN bun run build && test -f .next/standalone/server.js

# Flattened snarkjs tree via npm (bun nests wasmcurves/@iden3 under snarkjs differently;
# incomplete copies make /api/solana/pipeline-prove return 500 HTML).
FROM node:22-bookworm-slim AS snarkjs-deps
WORKDIR /prove
# pipeline-prove needs snarkjs + circomlibjs (Poseidon) and their flattened transitive deps.
RUN npm init -y >/dev/null \
  && npm install --omit=dev snarkjs@0.7.5 circomlibjs@0.1.7 @iden3/binfileutils@0.0.12

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

RUN groupadd -g 10001 siphon && useradd -u 10001 -g siphon -s /bin/bash siphon

COPY --from=builder /app/public ./public
COPY --from=builder --chown=siphon:siphon /app/.next/standalone ./
COPY --from=builder --chown=siphon:siphon /app/.next/static ./.next/static
# Merge npm-flattened snarkjs/circomlibjs deps into standalone node_modules.
# Also pull circomlibjs from the bun builder tree (already in package.json) in case npm nest differs.
COPY --from=snarkjs-deps /prove/node_modules /tmp/snarkjs_modules
COPY --from=builder /app/node_modules/circomlibjs /tmp/circomlibjs
RUN mkdir -p node_modules \
  && cp -a /tmp/snarkjs_modules/. node_modules/ \
  && rm -rf /tmp/snarkjs_modules \
  && rm -rf node_modules/circomlibjs \
  && cp -a /tmp/circomlibjs node_modules/circomlibjs \
  && rm -rf /tmp/circomlibjs \
  && test -f node_modules/snarkjs/package.json \
  && test -f node_modules/circomlibjs/package.json \
  && test -f node_modules/@iden3/binfileutils/package.json \
  && node -e "require('snarkjs'); require('@iden3/binfileutils'); console.log('snarkjs ok')"

USER siphon
EXPOSE 3000
CMD ["node", "server.js"]

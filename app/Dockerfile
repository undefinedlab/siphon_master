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
# serverExternalPackages: snarkjs is externalized — copy it AND its runtime deps (hoisted by bun).
# Missing @iden3/binfileutils crashes /api/solana/pipeline-prove with 500 HTML (executor then
# JSON-decodes garbage and mid-pipeline hangs after hop 0).
COPY --from=builder /app/node_modules/snarkjs ./node_modules/snarkjs
COPY --from=builder /app/node_modules/ffjavascript ./node_modules/ffjavascript
COPY --from=builder /app/node_modules/@iden3 ./node_modules/@iden3
COPY --from=builder /app/node_modules/@noble ./node_modules/@noble
COPY --from=builder /app/node_modules/r1csfile ./node_modules/r1csfile
COPY --from=builder /app/node_modules/fastfile ./node_modules/fastfile
COPY --from=builder /app/node_modules/circom_runtime ./node_modules/circom_runtime
COPY --from=builder /app/node_modules/bfj ./node_modules/bfj
COPY --from=builder /app/node_modules/ejs ./node_modules/ejs
COPY --from=builder /app/node_modules/logplease ./node_modules/logplease
RUN test -f node_modules/@iden3/binfileutils/package.json \
  || (echo "missing @iden3/binfileutils in runner image" >&2; ls -la node_modules/@iden3 || true; exit 1)

USER siphon
EXPOSE 3000
CMD ["node", "server.js"]

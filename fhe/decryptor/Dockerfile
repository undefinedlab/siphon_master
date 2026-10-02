# siphon-decryptor — runs in a Phala Cloud confidential VM (dstack / Intel TDX, linux/amd64).
# Holds ClientKeys in enclave memory, decrypts the FHE result bit, and — since the v3 fire-time
# prover landed — builds the Groth16 spend proof when a strategy trigger fires.
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory:
#
#   docker build --platform=linux/amd64 -f siphon-fhe/decryptor/Dockerfile -t siphon-decryptor .
#
# The crate now depends on `siphon-zk-v2/spend-core` by path (canonical Poseidon / ASP tree / SMT,
# so the enclave cannot drift from the circuits), and spend-core `include_str!`s
# `siphon-zk-v2/test-vectors/domains.json` at COMPILE time. Building from `siphon-fhe/decryptor`
# fails with a missing-path error.
#
# Platform: the Phala TDX runtime is linux/amd64. Pass --platform explicitly rather than hardcoding
# it here, so local arm64 dev doesn't fall back to slow QEMU emulation.

# --------------------------------------------------------------------------- rust
# 1.91+ needed: dstack-sdk's dependency tree (alloy) sets rust-version = 1.91.
FROM rust:1.91-bookworm AS builder
WORKDIR /build
COPY siphon-zk-v2/spend-core ./siphon-zk-v2/spend-core
COPY siphon-zk-v2/test-vectors ./siphon-zk-v2/test-vectors
COPY siphon-fhe/decryptor/Cargo.toml siphon-fhe/decryptor/Cargo.lock* ./siphon-fhe/decryptor/
COPY siphon-fhe/decryptor/src ./siphon-fhe/decryptor/src
WORKDIR /build/siphon-fhe/decryptor
RUN cargo build --release

# --------------------------------------------------------------------------- rapidsnark
# On a 2-vCPU tdx.small, snarkjs proves a swap leg in 6-12s; rapidsnark does it in well under one.
# That gap is the difference between a fill and a slipped price, so on the amd64 deployment target
# rapidsnark is mandatory (see the arch guard below). The snarkjs fallback exists for arm64 dev
# boxes only, where it is slow but correct.
#
# Uses Debian's verified GMP rather than rapidsnark's downloader, which can accept a mirror's HTTP
# error page as a download and then fail its checksum (same fix as proving-relayer/Dockerfile).
#
# Builds ONLY the `prover` target, never the default `all`. Upstream's default also links
# `librapidsnark.so`, and Debian's libgmp.a is not compiled -fPIC, so a shared object cannot link
# it:
#     relocation R_X86_64_PC32 against `__gmp_free_func` can not be used when making a shared
#     object; recompile with -fPIC
# That kills the build on BOTH arches (amd64 shows the message above; aarch64 shows "dangerous
# relocation"). We only ever exec the static `prover` binary, so the .so is pure liability.
# NOTE: proving-relayer/Dockerfile still does `make && make install` and will fail the same way
# the next time it is rebuilt — the clone is `--depth 1` off master, so this arrived from upstream
# rather than from any change here.
FROM debian:bookworm-slim AS rapidsnark
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl m4 nasm libgmp-dev libsodium-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Collected into /out so the runtime stage can COPY unconditionally (COPY has no `if`).
# On amd64 — the Phala target — a failure here fails the BUILD: silently shipping without
# rapidsnark would mean 6-12s proofs on 2 vCPU, discovered as slipped fills in production.
# On arm64 it is allowed to fail: Debian's aarch64 libgmp.a carries relocations rapidsnark cannot
# link ("dangerous relocation: unsupported relocation"), and local dev falls back to snarkjs.
RUN mkdir -p /out && ( set -e; \
    git clone --depth 1 https://github.com/iden3/rapidsnark.git /rapidsnark && \
    cd /rapidsnark && git submodule init && git submodule update && \
    GMP_MULTIARCH="$(gcc -print-multiarch)" && \
    if [ "$(uname -m)" = "aarch64" ]; then RAPID_TARGET=aarch64; GMP_PACKAGE=package_aarch64; \
    else RAPID_TARGET=host; GMP_PACKAGE=package; fi && \
    mkdir -p "depends/gmp/${GMP_PACKAGE}/include" "depends/gmp/${GMP_PACKAGE}/lib" && \
    ln -s "/usr/include/${GMP_MULTIARCH}/gmp.h" "depends/gmp/${GMP_PACKAGE}/include/gmp.h" && \
    ln -s "/usr/lib/${GMP_MULTIARCH}/libgmp.a" "depends/gmp/${GMP_PACKAGE}/lib/libgmp.a" && \
    mkdir build_prover && cd build_prover && \
    cmake .. -DTARGET_PLATFORM="${RAPID_TARGET}" -DCMAKE_INSTALL_PREFIX=../package && \
    make -j"$(nproc)" prover && \
    cp "$(find . -type f -name prover -perm -u+x | head -1)" /out/rapidsnark && \
    test -x /out/rapidsnark \
    ) || { \
      echo "rapidsnark build failed on ${TARGETARCH}"; \
      [ "${TARGETARCH}" != "amd64" ] || exit 1; \
      echo "non-amd64 dev build — continuing without rapidsnark (snarkjs fallback)"; \
    }

# --------------------------------------------------------------------------- runtime
FROM debian:bookworm-slim
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libgmp10 libsodium23 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g snarkjs@0.7.5 \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/siphon-fhe/decryptor/target/release/siphon-decryptor /usr/local/bin/siphon-decryptor
COPY --from=rapidsnark /out/ /usr/local/bin/

# The prover CLI and the shared libs it reuses. Deliberately the SAME files the test suite proves
# with (siphon-zk-v2/test/prove-witness.test.js) — a reimplementation here would be free to drift
# from the circuits, and a drifted witness only fails on-chain, after the trigger is spent.
COPY siphon-zk-v2/scripts/prove-witness.cjs /app/prover/prove-witness.cjs
COPY siphon-zk-v2/scripts/lib /app/prover/lib

# ALL 14 circuits (~1.0GB of keys). This used to be just the three arities a strategy leg can
# spend; the enclave now also serves /prove for user-initiated withdraw/merge/split/ragequit,
# and post-COMPLIANCE_CIRCUIT_SPLIT every private spend also needs a `complianceN` artifact for
# its arity — all six are in the guard list below, so a missing one fails the BUILD rather than
# the first withdrawal at that arity on a fresh CVM.
# and which withdraw arity a user needs is not known until they pick an amount, so the whole
# set has to be resident. This is what makes the image ~1.1GB — see the CVM disk note in
# docs/tee-prover.md before deploying.
#
# KEYS: the zkey/vkey come from ceremony/release-v5-split/zk, NOT from artifacts/. Both hold the same
# CIRCUIT — alpha, beta, gamma and every IC point are identical — and differ only in the phase-2
# DELTA. artifacts-v5/ carries witness wasms ONLY (the plain artifacts/ tree in this
# checkout is the 26-limb branch and must never be used here),
# `ceremonyStatus: dev-beacon`); Base's deployed SpendActionGroth16Router carries the ceremony
# delta. Proving with the wrong delta produces a proof that VERIFIES LOCALLY — prove-witness.cjs
# checks it against the same wrong vkey and is happy — and then reverts ProofFailed() on-chain,
# after the trigger is spent and the gas is paid. The .wasm is witness generation only, is
# delta-independent, and still comes from artifacts/.
# .dockerignore admits only artifacts-v5/*/*.wasm, so this carries no zkeys. It is ordered FIRST
# anyway so that even if that filter is ever loosened, the ceremony COPY below overwrites any
# dev-beacon key rather than the other way round — and SHA256SUMS then catches the residue.
# WHICH ceremony: release-v5-split, NOT release/. `ceremony/release/` is the round-2 pre-split
# set — 14 circuits, a DIFFERENT constraint system (withdraw1 is 24.5 MB there against 10.3 MB
# here) and no compliance keys at all. It carries its own consistent SHA256SUMS, so building from
# it passes every check below and then fails on-chain. release-v5-split is the PROGRAM_VERSION 5
# ceremony (mainnet beacon block 25911213) whose deltas were confirmed against all 20 verifiers
# deployed on Base.
COPY siphon-zk-v2/artifacts-v5/                       /app/prover/artifacts/
COPY siphon-zk-v2/ceremony/release-v5-split/zk/       /app/prover/artifacts/

ENV PORT=5002 \
    NODE_BIN=node \
    # groth16-prove.cjs::defaultRapidsnarkProver() probes RAPIDSNARK_PROVER, then RAPIDSNARK, then
    # the hardcoded /usr/local/bin/prover — it does NOT look for /usr/local/bin/rapidsnark. Without
    # this, PROVE_BACKEND=rapidsnark throws "rapidsnark backend requested but RAPIDSNARK_PROVER not
    # set" on the first leg that fires, hours after arming.
    RAPIDSNARK_PROVER=/usr/local/bin/rapidsnark \
    PROVER_SCRIPT=/app/prover/prove-witness.cjs \
    PROTOCOL_ARTIFACTS_DIR=/app/prover/artifacts \
    PROVE_BACKEND=rapidsnark \
    NODE_PATH=/usr/lib/node_modules

# Fail the build rather than the first strategy that fires: a missing zkey or a rapidsnark that
# cannot link its GMP would otherwise surface hours after arming, as a proof that never happens.
RUN { test -x /usr/local/bin/rapidsnark || [ "${TARGETARCH}" != "amd64" ]; } \
    && (cd /app/prover/artifacts && sha256sum -c SHA256SUMS) \
    && for c in withdraw1 withdraw2 withdraw3 withdraw4 withdraw5 withdraw6 \
                merge2 merge3 merge4 merge5 merge6 swap split ragequit \
                compliance1 compliance2 compliance3 compliance4 compliance5 compliance6; do \
           test -s "/app/prover/artifacts/$c/$c.wasm" \
             || { echo "missing witness wasm for $c"; exit 1; }; \
       done \
    && node -e "require('/app/prover/lib/witness-to-input.cjs'); require('/app/prover/lib/circuits.cjs')" \
    && node -e "require('snarkjs')" \
    && node -e "const{defaultRapidsnarkProver}=require('/app/prover/lib/groth16-prove.cjs'); \
        const p=defaultRapidsnarkProver(); \
        if(process.env.TARGETARCH==='amd64'&&!p) throw new Error('rapidsnark not resolvable: '+p); \
        console.log('rapidsnark resolved to '+p)"

# Sealed-only in prod: keys arrive as crypto_box_seal blobs bound to the attested enclave
# pubkey. SIPHON_DEV_PLAINTEXT_KEY=1 exists for LOCAL DEV only — never bake it in here.
EXPOSE 5002
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f "http://localhost:5002/health" || exit 1
CMD ["siphon-decryptor"]

FROM ubuntu:22.04@sha256:3b06811b2afd352be909dd088a004166d665dc76d38b13eada33522a9d915c6f AS rapidsnark-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates curl m4 nasm \
    libgmp-dev libsodium-dev \
    && rm -rf /var/lib/apt/lists/*

# rapidsnark — pin the reviewed upstream commit so a rebuild cannot silently change the prover.
ARG RAPIDSNARK_COMMIT=81eddf1a536d26497b237c0b8a04fe90baf7e439
# Use Ubuntu's verified GMP package rather than upstream's build_gmp.sh downloader, which can
# accept a mirror's HTTP error page as a download and then fail its checksum.
#
# Build ONLY the `prover` target. The default `all` also links librapidsnark.so, and the distro's
# libgmp.a is not -fPIC, so the shared object fails to link:
#     relocation R_X86_64_PC32 against `__gmp_free_func` can not be used when making a shared
#     object; recompile with -fPIC
# We only exec the static `prover` binary. Same fix as decryptor/Dockerfile.
RUN git clone https://github.com/iden3/rapidsnark.git /rapidsnark && \
    cd /rapidsnark && \
    git checkout --detach "$RAPIDSNARK_COMMIT" && \
    git submodule update --init --recursive && \
    GMP_MULTIARCH="$(gcc -print-multiarch)" && \
    if [ "$(uname -m)" = "aarch64" ]; then RAPID_TARGET=aarch64; GMP_PACKAGE=package_aarch64; else RAPID_TARGET=host; GMP_PACKAGE=package; fi && \
    mkdir -p "depends/gmp/${GMP_PACKAGE}/include" "depends/gmp/${GMP_PACKAGE}/lib" && \
    ln -s "/usr/include/${GMP_MULTIARCH}/gmp.h" "depends/gmp/${GMP_PACKAGE}/include/gmp.h" && \
    ln -s "/usr/lib/${GMP_MULTIARCH}/libgmp.a" "depends/gmp/${GMP_PACKAGE}/lib/libgmp.a" && \
    mkdir build_prover && cd build_prover && \
    cmake .. -DTARGET_PLATFORM="${RAPID_TARGET}" -DCMAKE_INSTALL_PREFIX=../package && \
    make -j4 prover && \
    cp "$(find . -type f -name prover -perm -u+x | head -1)" /usr/local/bin/rapidsnark && \
    test -x /usr/local/bin/rapidsnark

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

ENV HOME=/tmp \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ca-certificates curl libgmp10 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g snarkjs@0.7.4

COPY --from=rapidsnark-builder /usr/local/bin/rapidsnark /usr/local/bin/rapidsnark

WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv /opt/venv && pip install --no-cache-dir -r requirements.txt

COPY . .

RUN groupadd --gid 10003 siphon-prover && \
    useradd --uid 10003 --gid siphon-prover --shell /usr/sbin/nologin siphon-prover && \
    chown -R siphon-prover:siphon-prover /app && \
    node --version && command -v snarkjs >/dev/null && \
    (rapidsnark --help >/dev/null 2>&1 || true)

USER siphon-prover

EXPOSE 5010
CMD ["gunicorn", "--bind", "0.0.0.0:5010", "--workers", "1", "--threads", "2", "--timeout", "180", "app:app"]

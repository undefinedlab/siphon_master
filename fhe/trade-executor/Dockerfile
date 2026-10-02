FROM python:3.9-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies for web3.py/cryptography builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc-dev \
    libffi-dev \
    curl \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node runs relay-zk-withdraw.mjs (commit + spend). @solana/web3.js loads rpc-websockets,
# which is ESM; require() of that module needs Node 20.19+ / 22.12+.
ENV NODE_VERSION=22.23.3
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
    && node --version && npm --version

# Create non-root user for security
RUN groupadd -r siphon && useradd -r -g siphon siphon

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Isolated venv for the Polymarket CLOB SDK: py-clob-client needs eth-account>=0.13
# (hexbytes>=1.2), fundamentally incompatible with web3 6.x (hexbytes<0.4) in the main
# env. polymarket_client drives it via clob_bridge.py over a subprocess JSON pipe.
RUN python -m venv /opt/clob && /opt/clob/bin/pip install --no-cache-dir py-clob-client==0.34.6

# Isolated venv for Hyperliquid SDK (same eth-account pin clash). hyperliquid_client → hl_bridge.
COPY requirements-hl.txt .
RUN python -m venv /opt/hl && /opt/hl/bin/pip install --no-cache-dir -r requirements-hl.txt
ENV HYPERLIQUID_PYTHON=/opt/hl/bin/python

COPY . .

# Withdraw relay deps resolve next to the script via createRequire(import.meta.url).
RUN npm install --omit=dev --prefix /app/solana-scripts

# Create data directory and make entrypoint script executable.
# Strip CRLF so Windows checkouts do not break the shebang at runtime.
RUN mkdir -p /app/data \
    && sed -i 's/\r$//' entrypoint.sh \
    && chmod +x entrypoint.sh \
    && chown -R siphon:siphon /app

# Switch to non-root user
USER siphon

EXPOSE 5005

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5005/health || exit 1

# Use entrypoint script for DB init + start
ENTRYPOINT ["./entrypoint.sh"]
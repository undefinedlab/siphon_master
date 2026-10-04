# siphon-aspv2 — one image, three process roles (api / postman / watcher).
#
# Pinned to a python:3.12 base: psycopg2-binary and the web3 stack publish wheels for it, so the
# image builds without a compiler on both amd64 (EC2) and arm64 (laptop).

# Node comes from the official image rather than apt: it pins the version, keeps npm out of the
# runtime layer, and does not depend on Debian's mirrors being reachable at build time.
FROM node:22-slim AS nodedeps
WORKDIR /nodeapp
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# core/poseidon.py has NO pure-Python fallback: it shells out to circomlibjs over a Node bridge,
# and raises "No Poseidon backend" without it. Every admit and every /set/path needs a hash, so
# an image without Node serves cached roots from the DB and fails the moment it must compute one.
COPY --from=nodedeps /usr/local/bin/node /usr/local/bin/node
COPY --from=nodedeps /nodeapp/node_modules /app/node_modules

# Requirements first so a code change does not re-resolve the dependency tree.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Fail the BUILD, not the first admit, if the Poseidon backend is missing or wrong.
# Vector is circomlib's canonical Poseidon(1,2) — same constant zkv2 fixtures assert.
RUN python -c "\
from core.poseidon import hash2; \
got = hash2(1, 2); \
want = 7853200120776062878684798364095072458815029376092732009249414926327459813530; \
assert got == want, f'Poseidon backend wrong: {got}'; \
print('poseidon ok')"

# Never run the compliance authority as root.
RUN useradd --system --create-home --uid 10001 asp && chown -R asp:asp /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CRLF so Windows checkouts do not produce "No such file or directory" on the shebang.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && chown asp:asp /usr/local/bin/docker-entrypoint.sh
USER asp

EXPOSE 5056

# The image has no curl; urllib is already present and does not widen the attack surface.
# Only meaningful for ASP_ROLE=api; workers disable healthchecks in Railway.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5056/health',timeout=4).status==200 else 1)"

# Role via ASP_ROLE: api | postman | watcher | postman-sol | watcher-sol
# Chain via ASP_CHAIN_ID for EVM postman/watcher.
ENV ASP_ROLE=api
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

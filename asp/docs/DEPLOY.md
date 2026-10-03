# Deploying siphon-aspv2

The ASP is the compliance authority: if it is down, no deposit can be admitted and no spend
can prove. If it is misconfigured, it can admit things it should not. `ASP_ENV=production`
turns on `PRODUCTION_LOCK` in `config.py`, which refuses to boot rather than run degraded —
treat a failed start as the system working, and read the exception.

## 1. Prepare the env file

```bash
cp .env.production.example .env.production
chmod 600 .env.production          # holds ASP_POSTMAN_KEY
```

Generate the secrets:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # ASP_PENDING_SALT_KEY
openssl rand -hex 24               # each of SCREEN / POSTMAN / ADMIN token (must be distinct)
openssl rand -hex 16               # POSTGRES_PASSWORD
```

Two that are easy to get wrong:

- **`ASP_RPC_URL` must be a paid endpoint.** The watcher polls `getLogs` continuously and the
  postman has to land root publishes. A rate-limited watcher admits nothing and says so
  nowhere — it reports `scanned: 0, admitted: 0, errors: 0`.
- **`VAULT_KERNEL_<chainId>`** must be set. `ALLOW_ANY_VAULT` is forbidden in production, so an
  unset kernel rejects every admit on the vault-pin check.

## 2. Bring it up

```bash
docker compose --env-file .env.production up -d --build
```

Three roles share one image: `asp` (API, loopback only), `postman` (root publisher), `watcher`
(Deposited scanner), plus Postgres and Redis.

**Exactly one postman replica, always.** It is the only writer of on-chain roots; two would
collide on the nonce and burn the postman's gas on reverts. Do not `--scale postman`.

## 3. Verify

```bash
curl -s localhost:5056/health     # {"ok":true,...}
curl -s localhost:5056/ready      # must be {"ready":true} before taking traffic
```

`ready` fails with `zkme_unconfigured` until `ZKME_MCH_NO` and `ZKME_API_KEY` are set in
`.env.production`. After keys are set, run:

```bash
python scripts/zkme_smoke.py
# optional live ASP check:
ASP_URL=https://api.siphon.money/aspv2 ASP_SCREEN_TOKEN=... python scripts/zkme_smoke.py
```

Production ASP URL (TLS in front of Caddy): `https://api.siphon.money/aspv2`

`ready` is the real gate. Expect it to fail first with `lists_unseeded` until the OFAC/mixer
seeds land, and with `zkme_unconfigured` until KYT credentials are set (leave zkMe empty to run
lists + oracle only — that is a supported mode, not a defect).

Then prove the chain wiring end to end rather than trusting the health check:

```bash
python scripts/trace_deposited.py --tx <a real deposit tx>
```

That decodes one real `Deposited` log with the ABIs from contracts-v2, asp-v2 and indexer-v2 at
once. All three must agree — a mismatch is the failure that hides, because the watcher stays
green while admitting nothing.

## 4. Put TLS in front

Only `asp` listens, and only on `127.0.0.1`. Terminate TLS and authenticate at Caddy on the box.
`ASP_HOST_PORT` moves the host-side port if 5056 is taken.

## Operational notes

**The postman address is immutable.** `ComplianceHub.postman` has no setter, and `VaultKernel.hub`
is immutable too — so rotating a compromised postman key means redeploying the hub *and* the
kernel, i.e. a new vault and a fund migration. Point `postman` at a contract/Safe you control at
deploy time so the signing key behind it can rotate while the address stays fixed. The same
applies to `governance`.

**Back up `ASP_PENDING_SALT_KEY` with the postman key.** It is the Fernet material encrypting
pending deposit salts at rest; losing it strands every screened-but-not-yet-admitted deposit.

**Postgres holds the association set.** The ASP tree is rebuilt from it, and the on-chain root
is a commitment to that tree — lose the volume and published roots no longer correspond to any
tree you can produce paths from. Back up `aspv2-pgdata`, not just the env file.

**Seeds are vendored** at `data/seed/`. `config.py` falls back to `../siphon-asp/data/seed/` for
monorepo checkouts, but that path does not exist inside the container, which is why the copies
are in this repo.

## Compliance (KYT + zkKYC)

End-to-end flows with sequence diagrams: [COMPLIANCE_FLOWS.md](./COMPLIANCE_FLOWS.md)

zkMe production rollout (env, Amplify, verify): monorepo `audits/ASPV2_ZKME_DEPLOY.md`

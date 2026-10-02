# Executor Box — Rebuild Runbook

**Host:** `54.221.134.175` (`api.siphon.money`, `fhe.siphon.money`, `54-221-134-175.sslip.io`)
**Scenario:** the instance is gone — wiped, terminated, or compromised.
**Written:** 2026-09-02. Facts below were read off the running box, not assumed.

`DISASTER_RECOVERY.md` lists this host's recovery time as *unknown* because no procedure existed.
This is that procedure. **It has not been rehearsed** — see "Before you trust this" at the end.

---

## What actually runs here

Two compose projects plus standalone containers, ~20 containers total:

| Project | Directory | In git? |
|---|---|---|
| `siphon-fhe` | `/home/ubuntu/siphon-release/siphon-fhe` | **No `.git`** — restore from `siphon-fhe` main |
| `siphon-aspv2` | `/home/ubuntu/siphon-aspv2` | **No `.git`** — restore from `siphon-asp-v2` main |
| (standalone) | `siphon-indexer-v3base`, `siphon-indexer-v2` | started outside either project |

Neither directory is a checkout. Both are curated trees, which is why they drifted from GitHub in
the first place. As of 2026-09-02 both are reconcilable: `siphon-fhe` main contains the merged
executor (`3f1bc93`), and `siphon-asp-v2` main contains the merged zkMe/per-chain work (`96ead6f`).

### Start order — derived from `depends_on`, not guessed

```
1. postgres, redis, fhe-engine          (no dependencies)
2. siphon-indexer-sepolia               (postgres)
3. asp                                  (postgres, siphon-indexer-sepolia)
4. trade-executor                       (fhe-engine, asp)
5. api-gateway, api-gateway-worker      (postgres, redis, trade-executor)
6. caddy                                (api-gateway, proving-relayer, both app services)
```

`proving-relayer`, `proving-relayer-legacy`, `siphon-app-current`, `siphon-app-legacy`,
`asp-watcher` and the other indexers have no ordering constraint beyond postgres.

`docker compose up -d` honours this graph on its own. The order matters when you are bringing
services up one at a time to diagnose a failure.

---

## State that is NOT in git and NOT rebuildable

Restore these or the box comes back wrong. This is the part a `git clone` does not give you.

| What | Where | Source of truth |
|---|---|---|
| `.env` — 111 keys, 7 irreplaceable | `siphon-release/siphon-fhe/.env` | age-encrypted off-box (`backup-secrets.sh`) |
| `.env.production` — ASP v2 | `/home/ubuntu/siphon-aspv2/` | age-encrypted off-box |
| ZK proving artifacts, 722 MB | `siphon-release/zk-build-current` | S3 `siphon-zk-artifacts`; mounted `:ro` at `/app/zk` |
| Strategy + notes DB | volume `siphon-fhe_trade-executor-data` | nightly 03:35 UTC → `s3://siphon-service-db-backups-…` |
| Gateway/indexer Postgres | volume `siphon-fhe_postgres_data` | same nightly job |
| ASP v2 Postgres | volume `siphon-aspv2_aspv2-pgdata` | same nightly job |
| TLS certs / Caddy state | volumes `siphon-fhe_caddy-{data,config}` | regenerates from Let's Encrypt |
| Redis | volume `siphon-fhe_redis-data` | ephemeral, rate-limit counters only |

`EXECUTOR_PRIVATE_KEY` and `ASP_POSTMAN_KEY_8453` are in that `.env` and exist nowhere else
recoverable. **Without the age key you do not get this box back**, regardless of anything else here.

The ZK artifacts are the same zkeys the browser fetches. A mismatched or missing set means
withdrawals cannot be proven — see `zk-per-chain-proving-keys`: Base uses the ceremony delta and
Sepolia the dev-beacon set, and the wrong set passes local verify then reverts `ProofFailed()`
on-chain.

---

## Rebuild

### 0 · Before touching anything

Confirm you can decrypt a backup **first**. A rebuild that reaches step 6 and then discovers the
age key is wrong has burned the outage window.

```bash
age -d -i <key> <newest .age archive> | head -c 100
```

### 1 · Instance

Match the original: Ubuntu, x86_64 (**not ARM** — the FHE engine returns wrong results on aarch64,
see `local-fhe-engine-arm-bug`), enough disk for 722 MB of zkeys plus images (the current box uses
55% of 76 GB). IMDSv2 required. Security group: 22 from your IP, 80, 443. **Do not re-open 5005** —
it is currently `0.0.0.0/0` on the old box and nothing should answer on it.

Attach the instance role that grants `PutObject` + `ListBucket` on the backup buckets and nothing
else. Restores run from an operator machine; the box deliberately cannot read its own backups.

### 2 · Docker, then the trees

```bash
git clone git@github.com:SiphonMoney/siphon-fhe.git  /home/ubuntu/siphon-release/siphon-fhe
git clone git@github.com:SiphonMoney/siphon-asp-v2.git /home/ubuntu/siphon-aspv2
```

Both on `main`. Before 2026-09-02 this step produced a materially different executor; it no longer
does. If you are reading this after further drift, verify before trusting it:

```bash
# every file on the box that matches no commit in the repo
find . -name '*.py' -exec sha256sum {} \; > /tmp/box.sha   # then compare against all refs
```

### 3 · Secrets

Decrypt both `.env` files into place, `chmod 600`. Neither has a trailing newline — append with
`printf '\nKEY=value\n' >>`, never `echo`.

`ASP_COMPLIANCE_VAULT` **must stay per-chain** (`ASP_COMPLIANCE_VAULT_8453` for Base, the bare key
as the Sepolia fallback). A single global value sends Base users' fees to an address with no
contract and no key — this has already stranded ETH once.

### 4 · ZK artifacts

Pull `zk-build-current` from S3 into `siphon-release/`. Verify against
`current-artifacts.sha256` before starting anything that proves. Never delete circuits to save
space: every folder is reachable by some proof path.

### 5 · Databases

From an **operator machine**, not the box: pull the newest `.age` dumps, decrypt, restore into the
volumes. Verify by **row count per table**, never by exit code — a failed glob feeds `psql` an empty
file, which exits 0 and reports success while restoring nothing.

### 6 · Bring up

```bash
cd /home/ubuntu/siphon-release/siphon-fhe
docker compose -f docker-compose.prod.yml build          # first build is slow: rapidsnark compiles
docker compose -f docker-compose.prod.yml up -d
cd /home/ubuntu/siphon-aspv2
docker compose --env-file .env.production up -d --build
```

Never `docker compose down -v` — `-v` deletes the named volumes, i.e. the databases.

### 7 · Verify — behaviour, not config

```bash
curl -s http://127.0.0.1:5056/ready        # {"ready":true,"issues":[]}
curl -s https://api.siphon.money/aspv2/health
docker ps --format '{{.Names}} {{.Status}}' | grep -v healthy   # expect none unhealthy
docker exec siphon-trade-executor sh -c '[ -n "$SENTRY_DSN" ] && echo dsn ok'
docker exec siphon-aspv2-asp-1 python /app/scripts/zkme_smoke.py   # in the container; host lacks dotenv
```

Then the only test that really matters: **a real deposit and a real withdrawal on Base.** Everything
above can pass while proving is broken, because a wrong proving-key set fails only on-chain.

---

## Before you trust this

**This procedure has not been executed.** Two restore drills on this infrastructure have already
produced false passes — a `pg_dump --clean` backup that could not restore into an empty database,
and a restore that printed `RESTORE OK` while restoring nothing. A runbook nobody has run is a
hypothesis.

Rehearse it on a throwaway instance and record the measured time. Until then, treat the estimate as
unknown rather than substituting a number.

**Cheap stopgap meanwhile:** daily EBS snapshots of this volume, 7-day retention. That covers the
compose files, the `.env`s and the artifact tree in one action, and is worth having even once this
runbook is proven.

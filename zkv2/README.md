# zkv2

> Part of **`siphon_master`** — normative Circom Groth16 prover + `spend-core`.

EVM privacy-pool spend proofs. **Product stack:** Circom → Groth16 (BN254) + Rust `spend-core` reference.

**In this monorepo:** sources only (circuits, SDK, docs, test vectors). Bulky proving artifacts (`*.zkey`, `*.ptau`, `artifacts-from-v5/`) are **not** vendored here — client-facing keys for the app live under [`../app/public/zk`](../app/public/zk).


## Normative spec

`[PROTOCOL.md](./docs/PROTOCOL.md)` v3.5.0 — D1 asset-bound notes, privacy-first publics (`outLabel` limb = 0, MERGE amount not public), salted labels, deposit amount bind, cryptographic ragequit, Circom Groth16 product path, 5-minute admit epoch. `PROGRAM_VERSION=3`.


| Layer                                                  | Location                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Core (witness, ASP+SMT private spend, ragequit escape) | `/docs/PROTOCOL.md`                                                      |
| EVM binding                                            | `[chain-profiles/evm-v1.json](./chain-profiles/evm-v1.json)`, §16        |
| Program pin                                            | `[manifest/universal-spend-v1.json](./manifest/universal-spend-v1.json)` |


Architecture: `[docs/ARCHITECTURE-GREENFIELD.md](./docs/ARCHITECTURE-GREENFIELD.md)`  
Security closure: `[docs/OMEGA-CLOSURE.md](./docs/OMEGA-CLOSURE.md)`  
Benches: `[docs/benchmarks/groth16-bench.md](./docs/benchmarks/groth16-bench.md)`

Copy `[.env.example](./.env.example)` for local ASP client / prove env (`ASP_URL`, `ASP_SCREEN_TOKEN`, `ASP_ALLOWED_ORIGINS`).

**Tests:** Circom jest in `test/`; Rust vectors in `[../siphon-tests/zkv2/](../siphon-tests/zkv2/)`

## Compliance & exit paths (v3.5.0 / D1)


| User state                       | Private spend (§5.1) | RAGEQUIT (§5.2.1)      |
| -------------------------------- | -------------------- | ---------------------- |
| Pre-first-admit (empty ASP)      | ❌                    | ✅ pending              |
| KYT passed, awaiting admit epoch | ❌                    | ❌ wait for ASP publish |
| Admitted                         | ✅ ASP + SMT          | ❌ use withdraw         |
| KYT failed / flagged (in SMT)    | ❌                    | ✅ revoked              |




## Compliance clock (aspv2 + contracts-v2)

Private spend requires **current** `admittedRoot` + `revokedRoot` on `ComplianceHub`, plus ASP inclusion and SMT non-inclusion paths from aspv2.

```javascript
const asp = require("./sdk/aspClient");
const {
  proveSpend,
  deriveExpectedPublics,
  consentHostedProve,
} = require("./sdk");
const { witnessToCircomInput } = require("./scripts/lib/witness-to-input.cjs");

// On-chain roots (ComplianceHub + NoteTree) — required for proveSpend (GF-M1 / F-5)
const vaultRoots = {
  stateRoot: noteTreeRoot,
  admittedRoot: complianceHub.admittedRoot(),
  revokedRoot: complianceHub.revokedRoot(),
};

// 1. Paths from aspv2 (after deposit → /set/admit → postman publish)
const compliance = await asp.loadComplianceWitnessMulti({
  aspBaseUrl: process.env.ASP_URL || "http://127.0.0.1:5056",
  screenToken: process.env.ASP_SCREEN_TOKEN,
  labels: witness.inputs.map((i) => i.inLabel),
});

// 2. Merge — applyComplianceWitness requires matching inLabel per input slot (F-3)
const merged = asp.applyComplianceWitness(witness, compliance);

// 3. Prove (local T0 default; T1 hosted needs consentHostedProve + hostedProve callback)
const expectedPublics = deriveExpectedPublics(merged);
const circomInput = witnessToCircomInput({ ...merged, expectedPublic: expectedPublics });

const out = await proveSpend({
  action: merged.action,
  inputCount: merged.inputCount,
  input: circomInput,
  witnessJson: merged,
  expectedPublics,
  vaultRoots, // mandatory — rejects stale roots before prove
  prefer: "local",
});
```

**Deposit screen (aspv2):** `screenDepositor` sends `{ chainId, depositor, commitment, userSalt?, vault? }` — not `precommitment`. KYT fee helpers: `checkKytEntitlement`, `verifyKytFee` (402 gate on `/screen`).

**ASP client security:** Bearer calls default to **loopback** origins only. Production: set `ASP_ALLOWED_ORIGINS` (comma-separated). See `.env.example`.

**Circom note:** `revokedSmtLeaf` is the **claimed slot leaf** (`claimedLeaf` from `/set/smt-path`), usually `0` when unrevoked — not `leafHash(label)`.

Bootstrap Anvil + empty roots: [`../siphon-aspv2/scripts/BOOTSTRAP.md`](../siphon-aspv2/scripts/BOOTSTRAP.md).

## SDK (`sdk/`)

| Export | Role |
| ------ | ---- |
| `proveSpend` | Local (T0) or hosted (T1) Groth16 prove; requires `witnessJson`, `expectedPublics`, **`vaultRoots`** |
| `deriveExpectedPublics` | 25-limb publics via spend-core (stdin to `siphon-prove`, no disk witness) |
| `consentHostedProve` | T1 UX receipt + freeze-list digest (not remote prover auth — see OMEGA-CLOSURE F-10) |
| `assertRootsCurrent` / `assertPublicsMatch` | TOCTOU + limb bind helpers |
| `aspClient.*` | aspv2 HTTP: roots, paths, screen, admit, KYT fee |

Hosted prove (T1): remote callback must return a proof that passes **local Groth16 verify** against pinned `verification_key.json` (F-2).

## Circom Groth16 (product — PROTOCOL 25-limb)

```bash
npm ci
npm run build          # withdraw1..6, merge2..6, swap, split, ragequit → artifacts/
npm test               # real Groth16 when artifacts/ present (run npm run build first)
npm run bench:prove -- withdraw1   # snarkjs vs rapidsnark (if RAPIDSNARK_PROVER set)
npm run prove:groth16 -- --circuit withdraw1 --input witness.json
npm run export:verifiers
```



## Reference validate (CI)

`spend-core` + native guest — check witness → 25 limbs (not a Groth16 proof):

```bash
cargo run -p siphon-prove --release -- \
  --witness test-vectors/withdraw-w3-ok.json --bench-iters 50

# stdin (no temp witness file — used by deriveExpectedPublics):
cargo run -p siphon-prove -- --witness - < test-vectors/withdraw-w3-ok.json
```


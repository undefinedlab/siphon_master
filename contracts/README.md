# contracts

> Part of **`siphon_master`** — on-chain kernel for Siphon private spend.

Greenfield on-chain stack for Siphon spend **v3**. Normative chain binding of PROTOCOL 3.4.x (Circom Groth16 / 25-limb public inputs). **Not** a patch of `siphon-contracts` (v1).

**Crypto note:** verifiers and `VaultKernel.spend` expect **real Groth16 proofs**. There is no mock-verifier production path in this tree — Foundry tests load guest `expectedPublic` and exercise the kernel with protocol-aligned inputs.

| | |
| --- | --- |
| **Status** | **PROTOCOL 3.4.3** — M4 kernel shipped. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **Normative spec** | `siphon-zkv2/PROTOCOL.md` **v3.4.3** |
| **Privacy product** | [`docs/PRIVACY.md`](docs/PRIVACY.md) |
| **Deploy checklist** | [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| **Architecture** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **Cross-stack** | [`docs/INTEGRATION.md`](docs/INTEGRATION.md) (aspv2 + zkv2) |
| **Security closure** | [`docs/OMEGA-CLOSURE.md`](docs/OMEGA-CLOSURE.md) |

**Do not copy** v1’s 14 Groth16 verifiers, 32-slot ASP ring, or per-action Entrypoint methods.

## What this is

A **modular, chain-portable vault kernel**:

1. One `spend(publicInputs[25], proof, actionCalldata)` per vault — **relayer-callable**.
2. Shared **ComplianceHub**: current `admittedRoot` + `revokedRoot` only. Default **5-minute admit epoch**; revoke immediate.
3. **Register-only VerifierRegistry** pinned by `programVersion` (**2** as of 3.4.3).
4. Assets and AMMs are **adapters**.
5. MERGE does **not** publish merged amount (`public[5]=0`); insert `outCommitment` only.
6. EVM first; Circom Groth16 verification artifact; other chains may reuse 25-limb semantics.

## Layout

```
siphon-contracts-v2/
  docs/                 architecture, integration, OMEGA closure, multi-chain
  spec/                 public-input indices + module contracts
  profiles/             chain profiles (evm-v1 normative, solana-v1 Devnet ZK vault)
  evm/                  Foundry — interfaces, kernel libraries, hub/registry
  solana/               Devnet ZK vault (siphon-vault-zk) + retired scaffold
```

## Principles (non-negotiable)

- **PROTOCOL.md wins** when code and comments disagree.
- **Do not publish `inLabel[]`** to close revocation. Revocation is SMT non-inclusion + current `revokedRoot`.
- **Proof-first:** amounts, roots, nullifiers, payee binding come from verified `publicInputs`.
- **One semantic core, Circom Groth16 prove.**
- **Ragequit is attributed.** Private spend is the private path.
- **No Phase A / Phase B split.** First `PROGRAM_VERSION` is this kernel.

## Build & deploy (EVM)

```bash
cd evm
forge test
npm run test:docs   # PROTOCOL 3.4.3 doc alignment (also in CI)
npm run test:env    # deployment env aliases
```

Deploy scripts (ported from v1 — see [`evm/scripts/README.md`](evm/scripts/README.md)):

```bash
cd evm
cp .env.example .env
npm run deploy:simulate    # dry-run
npm run deploy:local       # anvil + SimpleErc20 adapters
```

Requires [Foundry](https://book.getfoundry.sh/).

### M3 / M4 status

| Piece | Status |
| --- | --- |
| `PublicInputs` library (25 limbs, kernel pre) | ✅ |
| `VerifierRegistry` (register-only) | ✅ |
| `ComplianceHub` (current roots) | ✅ |
| `SpendActionGroth16Router` (14 action VKs) | ✅ |
| Foundry `PublicInputsMatchGuestCommit` | ✅ loads guest `expectedPublic` |
| `VaultKernel.spend` + NoteTree + NullifierSet | ✅ M4 |
| Action finalize (withdraw/merge/swap/split/ragequit) | ✅ M4 |
| `Erc20AssetAdapter` + `Erc20SettlementAdapter` | ✅ measured pull/push |
| Real Groth16 (`SpendActionGroth16Router` + 14 action VKs) | ✅ M4/M5/M8 vault path |
| PoseidonT3 hasher (`PoseidonHasher2`) | ✅ note + split trees |
| Circom Groth16 product stack | ✅ (zkVM / SP1 path removed) |

```
siphon-contracts-v2/evm/
  src/
    interfaces/
    adapters/
    libraries/PublicInputs.sol
    VerifierRegistry.sol
    ComplianceHub.sol
    NoteTree.sol
    NullifierSet.sol
    VaultKernel.sol
  test/M3.t.sol
  test/M4.t.sol
```

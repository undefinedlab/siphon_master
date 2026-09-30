# siphon-contracts-v2
#
# A clean clone previously could not build: lib/ is gitignored, there is no .gitmodules, and no
# install step was documented, so `forge test` failed on a missing forge-std. `make setup` is now
# the one command that takes a fresh checkout to a building tree.

FORGE_STD_REV := 9b91af55d5944be8fb986e6cb7cde7ad2d01b890
EVM           := evm
RPC           ?= http://127.0.0.1:8545

# Canonical poseidon-solidity deployments. Our own via_ir build of these libraries exceeds
# EIP-170 (T3 29315, T4 32895 > 24576) and cannot be deployed at all, so evm/foundry.toml links
# these addresses instead. They exist on Sepolia and Base; a fresh local chain has to be seeded.
POSEIDON_T3   := 0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93
POSEIDON_T4   := 0x4443338EF595F44e0121df4C21102677B142ECF0
POSEIDON_SRC  ?= https://ethereum-sepolia-rpc.publicnode.com

.PHONY: setup build test anvil-poseidon clean

setup:
	@command -v forge >/dev/null || { echo "foundry missing: https://getfoundry.sh"; exit 1; }
	@if [ ! -f $(EVM)/lib/forge-std/src/Test.sol ]; then \
		echo "==> vendoring forge-std @ $(FORGE_STD_REV)"; \
		rm -rf $(EVM)/lib/forge-std; \
		git clone -q https://github.com/foundry-rs/forge-std.git $(EVM)/lib/forge-std; \
		git -C $(EVM)/lib/forge-std checkout -q $(FORGE_STD_REV); \
	else echo "==> forge-std present"; fi
	@echo "==> npm ci (poseidon-solidity)"
	@cd $(EVM) && npm ci --silent 2>/dev/null || (cd $(EVM) && npm install --silent)
	@echo "==> setup complete"

build: setup
	@cd $(EVM) && forge build

test: setup
	@cd $(EVM) && forge test

# Seed a local chain with the canonical Poseidon bytecode. Without this the linked libraries have
# no code, and a DELEGATECALL to an empty address returns silently rather than reverting — every
# hash would be quietly wrong. DeployVaultStack preflights for exactly this.
anvil-poseidon:
	@for a in $(POSEIDON_T3) $(POSEIDON_T4); do \
		code=$$(cast code $$a --rpc-url $(POSEIDON_SRC)); \
		if [ -z "$$code" ] || [ "$$code" = "0x" ]; then echo "no code for $$a at $(POSEIDON_SRC)"; exit 1; fi; \
		cast rpc anvil_setCode $$a "$$code" --rpc-url $(RPC) >/dev/null; \
		echo "seeded $$a ($$(cast codesize $$a --rpc-url $(RPC)) bytes)"; \
	done

clean:
	@cd $(EVM) && forge clean && rm -rf node_modules lib

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {PublicInputs} from "../src/libraries/PublicInputs.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";
import {ComplianceHub} from "../src/ComplianceHub.sol";
import {VaultKernel} from "../src/VaultKernel.sol";

/// @notice Post-deploy governance / ops (v1 `initVaults.ts` + registry wiring analogue).
///
/// Env:
///   VAULT_KERNEL_ADDRESS
///   VERIFIER_REGISTRY_ADDRESS
///   SPEND_ROUTER_ADDRESS     — SpendActionGroth16Router
///
/// Optional:
///   SEED_HISTORICAL_ROOT     — uint256 for migration (requires deposits paused + empty tree)
///   PAUSE_DEPOSITS           — "true" | "false"
///   PROPOSE_VERIFIER         — "true" when minDelay > 0
///   REGISTER_VERIFIER        — "true" after timelock matured
contract BootstrapVault is Script {
    function run() external {
        address vaultAddr = vm.envAddress("VAULT_KERNEL_ADDRESS");
        address registryAddr = vm.envAddress("VERIFIER_REGISTRY_ADDRESS");
        address router = vm.envAddress("SPEND_ROUTER_ADDRESS");

        VaultKernel vault = VaultKernel(vaultAddr);
        VerifierRegistry registry = VerifierRegistry(registryAddr);
        bytes32 programHash = keccak256(router.code);

        vm.startBroadcast();

        if (vm.envOr("PROPOSE_VERIFIER", false)) {
            registry.proposeVerifier(PublicInputs.PROGRAM_VERSION, router, programHash);
            console2.log("proposeVerifier queued");
        }

        if (vm.envOr("REGISTER_VERIFIER", false)) {
            registry.registerVerifier(PublicInputs.PROGRAM_VERSION, router, programHash);
            console2.log("registerVerifier done");
        }

        if (vm.envOr("PAUSE_DEPOSITS", false)) {
            vault.setDepositsPaused(true);
            console2.log("deposits paused");
        }

        if (vm.envOr("UNPAUSE_DEPOSITS", false)) {
            vault.setDepositsPaused(false);
            console2.log("deposits unpaused");
        }

        if (bytes(vm.envOr("SEED_HISTORICAL_ROOT", string(""))).length > 0) {
            uint256 root = vm.envUint("SEED_HISTORICAL_ROOT");
            vault.seedHistoricalRoot(root);
            console2.log("seedHistoricalRoot", root);
        }

        vm.stopBroadcast();
    }
}

/// @notice Postman bootstrap — publish initial compliance roots.
/// Env: COMPLIANCE_HUB_ADDRESS, ADMITTED_ROOT, REVOKED_ROOT
contract PublishComplianceRoots is Script {
    function run() external {
        ComplianceHub hub = ComplianceHub(vm.envAddress("COMPLIANCE_HUB_ADDRESS"));
        uint256 admitted = vm.envUint("ADMITTED_ROOT");
        uint256 revoked = vm.envUint("REVOKED_ROOT");

        vm.startBroadcast();
        hub.updateAdmittedRoot(admitted);
        hub.updateRevokedRoot(revoked);
        vm.stopBroadcast();

        console2.log("admittedRoot", hub.admittedRoot());
        console2.log("revokedRoot", hub.revokedRoot());
    }
}

# API keys never grant spend authority

Siphon's business API uses API keys only for access, quotas, tenancy, policy, and observability; a
state-changing user instruction also requires a fresh wallet signature bound to the exact method,
path, chain, nonce, and canonical JSON body, while deposits and payouts require client-generated
note material or proofs. We rejected API-key-controlled wallets and default enclave custody because
a leaked business credential or compromised gateway would then be sufficient to move customer
funds. Relayed payouts retain a separate end-to-end wallet challenge so the gateway cannot replace
change-note ownership, and legacy enclave accounts remain isolated under `/v1/managed-accounts`
rather than being silently presented as self-custody.

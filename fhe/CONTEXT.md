# Siphon Commercial API

The commercial API lets a business coordinate private money movement while the end user's wallet
and locally held note secrets remain the only source of spend authority.

## Language

**API Key**:
A business credential that grants service access, quotas, policy, and observability. It never signs
transactions, creates proofs, or authorizes spending.
_Avoid_: Wallet key, custody key, signing key

**Wallet Authorization**:
A fresh EIP-191 signature over one exact method, path, chain, nonce, and canonical request body.
_Avoid_: Login signature, session token

**Account**:
A business-scoped association between an external customer reference and a user-controlled wallet.
It contains no wallet key or spendable note material.
_Avoid_: Managed wallet, custodial account, API wallet

**Note Material**:
The nullifier and secret that control a shielded note. It exists only in the client or user-chosen
key system.
_Avoid_: Account secret, server note

**Operation**:
The durable record of a deposit, payout, or strategy lifecycle that can be polled or delivered by
webhook.
_Avoid_: Transaction, job

**Payout**:
A proof-bound withdrawal from a shielded account to a public recipient.
_Avoid_: Transfer, managed withdrawal

**Relay Authorization**:
A single-use wallet challenge signature checked end to end by the transaction relayer. It permits
submission of an already proof-bound payout but does not reveal note secrets.
_Avoid_: Relayer API key, delegated custody

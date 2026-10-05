# Solana Mode E2E Contract (wrapper cut)

Solana product mode is a **Phantom front door**. Vault custody, notes, and ASP live on **Base**.
Native solana-v1 vault RPC must not appear; Base vault calls **are required** after the public bridge.

## Scenario: fund Base vault from Solana mode

1. Start the app with Solana mode enabled and valid test RPC configuration.
2. Register a request listener that records every RPC URL and method.
3. Open the deposit / fund flow and select Solana mode.
4. Click **Connect wallet** and choose **Phantom**.
5. Approve the connection in the mocked/test Phantom provider.
6. Assert the connected Phantom public key is shown.
7. Assert the **Fund Base vault** panel (`data-testid="solana-fund-base-panel"`) is visible.
8. Connect a Base (EVM) wallet (RainbowKit) as the bridge recipient / deposit signer.
9. Enter an amount and submit **Plan fund → Base vault**.
10. Assert the app calls `POST …/solana/fundBase/plan` (not a Solana Siphon vault program).
11. Assert the Base vault deposit UI (`EvmUserDash` / depositV3 path) is reachable in the same session.
12. Abort the test if any request targets a **Solana Siphon vault program / PDA deposit API**.
13. Allow (and after bridge, expect) Base vault `eth_call` / `eth_sendTransaction` against the EVM vault.

## Required Playwright assertions

- Solana mode never calls a Solana Siphon vault program.
- Phantom can be selected and reaches the connected state.
- Fund-Base panel is visible after Phantom connects.
- Base EVM wallet can be connected for custody.
- A missing Phantom provider produces an actionable wallet error.
- Product gates: `forbidsEvmVaultCalls(solana) === false` and `vaultCustodyChainId(solana) === 8453`.

Use stable `data-testid` selectors when this stub becomes executable; do not key tests to display
copy or wallet-modal CSS classes.

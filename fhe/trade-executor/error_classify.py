"""Map an execution failure reason to a SHORT human-readable category for the
`execution_error` log and operator prints — so a failed strategy reads
"Uniswap slippage (Too little received)" instead of a 300-char revert dump.

Dependency-free on purpose (classifies by exception class *name* + message
keywords, not by importing evm_executor) so it stays unit-testable in isolation.
Run the self-check:  python3 error_classify.py
"""


def classify_error(reason) -> str:
    name = type(reason).__name__ if isinstance(reason, BaseException) else ""
    msg = str(reason or "").lower()

    # 1) Exception type is the most reliable signal.
    if name == "NullifierSpentSwapFailed":
        return "Uniswap swap failed after withdraw (funds in custody — recoverable)"
    if name == "NullifierAlreadySpentError":
        return "Nullifier already spent on-chain"

    # 2) Message keywords, most-specific first (order matters).
    if "too little received" in msg or "token_to_weth" in msg or "weth_to_token" in msg:
        return "Uniswap slippage (Too little received)"
    if "already claimed" in msg or "double-spend" in msg or "double spend" in msg:
        return "Nullifier double-spend (note already claimed)"
    if "already spent" in msg or "nullifieralreadyspent" in msg:
        return "Nullifier already spent on-chain"
    if "withdrawalcostexceedsamount" in msg or ("withdraw" in msg and "cost" in msg and "exceed" in msg):
        return "Withdrawal cost exceeds amount (fee > trade size)"
    if "invalidzkproof" in msg or "zk_proof" in msg or "invalid proof" in msg:
        return "Invalid ZK proof"
    if "merkle" in msg or "stateroot" in msg or "state root" in msg:
        return "Merkle root / state mismatch"
    if "client key mismatch" in msg or "key mismatch" in msg:
        return "FHE key mismatch (re-arm required)"
    if "insufficient" in msg or "outoffunds" in msg or "out of funds" in msg:
        return "Insufficient funds / gas"
    if ("swap" in msg and "fail" in msg) or "swaprouter" in msg or "slippage" in msg:
        return "Swap failed"
    if ("missing revert data" in msg or "rate limit" in msg or "timeout" in msg
            or "connection" in msg or "-32603" in msg or "replacement transaction" in msg
            or "nonce" in msg):
        return "RPC / network error"
    if "arming fee" in msg:
        return "Arming fee invalid"
    if "would revert" in msg or "empty revert" in msg or "execution reverted" in msg or "reverted" in msg:
        return "On-chain revert (entrypoint/contract)"
    if not msg:
        return "Unknown error (no detail captured)"
    return "Unknown error"


if __name__ == "__main__":
    class NullifierSpentSwapFailed(Exception):
        pass

    class NullifierAlreadySpentError(Exception):
        pass

    cases = [
        (NullifierSpentSwapFailed("ZK withdraw ok, swap failed"), "Uniswap swap failed after withdraw (funds in custody — recoverable)"),
        ("ZK withdraw confirmed (0xabc) but swap failed: stage=token_to_weth ... (Revert string: Too little received). Custody recovery context: ...", "Uniswap slippage (Too little received)"),
        ("nullifier already claimed — double-spend guard aborted", "Nullifier double-spend (note already claimed)"),
        (NullifierAlreadySpentError(), "Nullifier already spent on-chain"),
        ("withdraw() would revert: NullifierAlreadySpent(123,456)", "Nullifier already spent on-chain"),
        ("withdraw() would revert: Custom error: WithdrawalCostExceedsAmount(9000,180027)", "Withdrawal cost exceeds amount (fee > trade size)"),
        ("InvalidZKProof()", "Invalid ZK proof"),
        ("circuit Merkle assert failed: stateRoot mismatch", "Merkle root / state mismatch"),
        ("decryptor: client key mismatch", "FHE key mismatch (re-arm required)"),
        ("EVM error: OutOfFunds", "Insufficient funds / gas"),
        ("missing revert data", "RPC / network error"),
        ("RPC 0xaa36a7 replacement transaction underpriced", "RPC / network error"),
        ("withdraw() would revert: 0x1234", "On-chain revert (entrypoint/contract)"),
        ("", "Unknown error (no detail captured)"),
        ("something totally novel", "Unknown error"),
    ]
    for reason, expected in cases:
        got = classify_error(reason)
        assert got == expected, f"{reason!r} -> {got!r}\n   expected {expected!r}"
    print(f"OK — classify_error covers {len(cases)} cases across all categories")

"""Postman-signed ASP snapshots — the freshness anchor for the TEE attested-spend path.

## Why this exists

`GET /set/leaves` hands the enclave the whole admitted + revoked leaf set so it can rebuild both
trees and derive paths locally (no per-label lookup, no deposit->spend correlation). The enclave
then vouches, in a signature the `ComplianceHub` trusts, that the spent note is not revoked.

That vouching is only worth something if the enclave's view of the revoked set is CURRENT. Before
this module the enclave checked its snapshot against roots supplied by its own caller
(`ProveReq.onchainAdmittedRoot` / `onchainRevokedRoot`), which was circular: the caller simply
echoed whatever this service had just served, and the check passed. It proved "the caller agrees
with the ASP", never "the ASP is current".

Under the old `spend()` path that circularity was harmless — the chain re-checked the root, so a
stale snapshot produced a reverting transaction and nothing worse. `spendAttested` removes exactly
that safety net: the hub accepts ANY once-published revoked root, so a stale-but-published snapshot
sails through and a revoked note spends.

So the ASP signs its own snapshot with a timestamp, and the enclave verifies both. The enclave no
longer takes any root from its caller.

## Why the postman key, and why that is enough

The postman is already the on-chain revocation authority — it is the only address `ComplianceHub`
accepts `updateRevokedRoot` from. Independence from it would be meaningless here: a malicious
postman can simply decline to revoke a label in the first place, and no amount of cross-checking
from the enclave constrains that. What the enclave actually needs independence from is TIME —
staleness and replay — and a signature over `issuedAt` gives exactly that, with no RPC credentials
inside the enclave and no new key to distribute.

`chainId` and `hub` bind into the digest so a snapshot signed for one deployment cannot be replayed
at an enclave watching another. `issuedAt` is what makes replay of an old snapshot detectable at
all; the enclave enforces a max age against it.
"""
from __future__ import annotations

from eth_account import Account
from eth_utils import keccak, to_canonical_address

# Mirrors ComplianceHub's ATTEST_TYPEHASH style (an abi.encode of a typehash + fixed-width fields)
# so anyone reading both sees one convention. This digest is NEVER verified on-chain — only inside
# the enclave — but the layout is kept identical so a future on-chain check needs no new format.
SNAPSHOT_TYPEHASH = keccak(
    b"SiphonAspSnapshot(uint256 chainId,address hub,uint256 admittedRoot,uint256 revokedRoot,uint256 issuedAt)"
)


def _u256(v: int) -> bytes:
    if v < 0 or v >= 1 << 256:
        raise ValueError(f"not a uint256: {v}")
    return v.to_bytes(32, "big")


def snapshot_digest(
    *,
    chain_id: int,
    hub: str,
    admitted_root: int,
    revoked_root: int,
    issued_at: int,
) -> bytes:
    """The 32-byte digest the postman signs. Must stay byte-identical to the Rust twin.

    Cross-language pinned by `tests/test_snapshot_sig.py::test_digest_matches_pinned_vector` and
    `decryptor/src/spend.rs::snapshot_digest_matches_the_python_vector`. Change one, change all
    three — a silent divergence here fails closed as "bad signer" at fire time, hours after arming.
    """
    # to_canonical_address rejects a bad checksum outright rather than silently signing for the
    # wrong hub, which would surface as an unexplained signature rejection inside the enclave.
    addr = to_canonical_address(hub)
    buf = b"".join(
        [
            SNAPSHOT_TYPEHASH,
            _u256(chain_id),
            b"\x00" * 12 + addr,  # address is right-aligned in its 32-byte word
            _u256(admitted_root),
            _u256(revoked_root),
            _u256(issued_at),
        ]
    )
    return keccak(buf)


def sign_snapshot(
    *,
    private_key: str,
    chain_id: int,
    hub: str,
    admitted_root: int,
    revoked_root: int,
    issued_at: int,
) -> str:
    """Sign a snapshot, returning `0x` + 65 bytes of r‖s‖v with v in {27,28}.

    eth_account emits the canonical low-S form, which is what the enclave's k256 recovery expects;
    the high-S twin would recover to a different address and read as a wrong signer.
    """
    digest = snapshot_digest(
        chain_id=chain_id,
        hub=hub,
        admitted_root=admitted_root,
        revoked_root=revoked_root,
        issued_at=issued_at,
    )
    signed = Account.unsafe_sign_hash(digest, private_key=private_key)
    v = signed.v if signed.v in (27, 28) else signed.v + 27
    return "0x" + (
        signed.r.to_bytes(32, "big") + signed.s.to_bytes(32, "big") + bytes([v])
    ).hex()

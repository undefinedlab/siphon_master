-- Note DB: stop the public anon key from overwriting note secrets.
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships inside the client JS bundle, so every capability granted to
-- `anon` is a capability granted to anyone who opens the dapp. Measured on 2026-09-02: anon could
-- SELECT all rows, INSERT, and UPDATE **every column** of every note table — including
-- precommitments.enc_blob and commitments.enc_blob, which hold the encrypted note secrets.
-- Overwriting one of those destroys the secret: the commitment stays on-chain, the note becomes
-- unspendable, and the funds are unrecoverable. DELETE was already denied; UPDATE was not, and
-- for this data UPDATE is just as destructive.
--
-- RLS was ENABLED on these tables, which is what made it look handled. Every policy was
-- `USING (true) / WITH CHECK (true)` — including the one named "select by tag", which does not
-- reference the tag. RLS cannot express "only these columns"; column-level GRANTs can, so that is
-- what this uses.
--
-- The grants below are the EXACT columns the frontend writes. Verified against the call sites,
-- not assumed:
--   precommitmentStore.ts  PATCH {status, claimed_at}          (claim / resolve / release / reap)
--   commitmentStore.ts     PATCH {spent, updated_at}           (markCommitmentSpent)
--   nullifierStore.ts      PATCH {status}                      (writeNullifier 409 fallback)
--   noteAuth.ts            POST  {wallet_address, enc_blob, iv} with
--                          Prefer: resolution=merge-duplicates -> a genuine upsert of its OWN row,
--                          so wallet_keys must keep enc_blob/iv writable. wallet_address is
--                          withheld so a row cannot be re-pointed at another wallet.
--
-- Not affected: the executor connects as `postgres` (NOTE_DB_URI), not `anon`, so it retains full
-- write access and can still create precommitments.
--
-- What this does NOT fix: anon can still SELECT every row (enumeration). The app only ever reads
-- with ?tag=eq. / ?id=eq. / ?nullifier_hmac=in.() filters, so nothing depends on enumeration — but
-- RLS cannot require that a filter was supplied. Closing it means moving reads to
-- `security definer` RPCs that take the tag as an argument, which is a client change. Tracked
-- separately; this file closes the destructive half, which is the half that loses money.
--
-- Idempotent. Safe to re-run. Apply to every note DB (hosted and self-hosted) — they were seeded
-- from the same dump and share the same permissive grants.

BEGIN;

-- precommitments — enc_blob/iv/tag/precommitment become read-only to the public key.
REVOKE UPDATE ON public.precommitments FROM anon;
GRANT  UPDATE (status, claimed_at) ON public.precommitments TO anon;

-- commitments — same, for both roles that currently hold blanket UPDATE.
REVOKE UPDATE ON public.commitments FROM anon, authenticated;
GRANT  UPDATE (spent, updated_at) ON public.commitments TO anon, authenticated;

-- nullifier_registry — only the spent flag moves.
REVOKE UPDATE ON public.nullifier_registry FROM anon;
GRANT  UPDATE (status) ON public.nullifier_registry TO anon;

-- wallet_keys — keeps its upsert, loses the ability to re-point a row at another wallet.
REVOKE UPDATE ON public.wallet_keys FROM anon;
GRANT  UPDATE (enc_blob, iv, updated_at, fhe_blob) ON public.wallet_keys TO anon;

COMMIT;

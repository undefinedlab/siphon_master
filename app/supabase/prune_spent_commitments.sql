-- Keep the `commitments` table small: delete long-spent notes server-side.
--
-- Why this exists (not done from the client): the browser uses the public anon key, which is
-- RLS-restricted to INSERT/UPDATE/SELECT — DELETE returns 401. Pruning therefore runs server-side
-- via pg_cron (full privileges, no RLS), so the table shrinks with zero client involvement.
--
-- SAFETY: only removes spent='true' rows older than 7 days. Those are dead weight — every spend
-- path filters spent==='true' out, and the on-chain nullifier set is the real double-spend guard,
-- so a withdrawn note's secret is never needed again. NEVER touches 'false' (spendable) or
-- 'pending' (reserved-by-a-strategy) rows. The 7-day buffer leaves time to notice any mis-flag.

-- One-time: enable pg_cron (Supabase dashboard → Database → Extensions → enable "pg_cron",
-- or run the line below once as a privileged role).
create extension if not exists pg_cron;

-- Idempotent (re)scheduling: unschedule an existing job of the same name, then (re)create it.
select cron.unschedule('prune-spent-commitments')
where exists (select 1 from cron.job where jobname = 'prune-spent-commitments');

-- Daily at 03:00 UTC.
select cron.schedule(
  'prune-spent-commitments',
  '0 3 * * *',
  $$
    delete from public.commitments
    where spent = 'true'
      and updated_at < now() - interval '7 days'
  $$
);

-- Ad-hoc one-off cleanup (run by hand in the SQL editor any time):
--   delete from public.commitments
--   where spent = 'true' and updated_at < now() - interval '7 days';

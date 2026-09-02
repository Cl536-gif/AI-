-- Remove only the dedicated FOR KEY SHARE test fixture.
BEGIN;
SET LOCAL ROLE diet_owner;

DELETE FROM app.user_merges
WHERE source_user_id = 'anon:fkshare_20260818_190000_k7m2'
  AND target_user_id = 'acct:fkshare_20260818_190000_k7m2';

-- The deployed 001 baseline keeps user_events.user_id as a restrictive FK.
-- Removing the merge first cascades its audit rows; events must then be
-- removed explicitly before the two fixture users can be deleted.
DELETE FROM app.user_events
WHERE user_id IN (
  'anon:fkshare_20260818_190000_k7m2',
  'acct:fkshare_20260818_190000_k7m2'
);

DELETE FROM app.users
WHERE user_id IN (
  'anon:fkshare_20260818_190000_k7m2',
  'acct:fkshare_20260818_190000_k7m2'
);

COMMIT;

SELECT
  'CLEANUP_PASS' AS status,
  (SELECT COUNT(*) FROM app.users
   WHERE user_id IN (
     'anon:fkshare_20260818_190000_k7m2',
     'acct:fkshare_20260818_190000_k7m2'
   )) AS remaining_users,
  (SELECT COUNT(*) FROM app.user_events
   WHERE user_id IN (
     'anon:fkshare_20260818_190000_k7m2',
     'acct:fkshare_20260818_190000_k7m2'
   )) AS remaining_events,
  (SELECT COUNT(*) FROM app.user_merges
   WHERE source_user_id = 'anon:fkshare_20260818_190000_k7m2') AS remaining_merges;

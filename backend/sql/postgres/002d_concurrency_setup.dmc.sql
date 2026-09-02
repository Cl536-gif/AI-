-- 002d FOR KEY SHARE concurrency test: one-time fixture setup.
BEGIN;
SET LOCAL ROLE diet_owner;

DO $test$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.users
    WHERE user_id IN (
      'anon:fkshare_20260818_190000_k7m2',
      'acct:fkshare_20260818_190000_k7m2'
    )
  ) OR EXISTS (
    SELECT 1
    FROM app.user_events
    WHERE event_id = 'fkshare_source_20260818_190000_k7m2'
  ) THEN
    RAISE EXCEPTION 'FOR KEY SHARE test fixture already exists; stop and inspect before retrying';
  END IF;
END
$test$;

INSERT INTO app.users (user_id, status)
VALUES
  ('anon:fkshare_20260818_190000_k7m2', 'active'),
  ('acct:fkshare_20260818_190000_k7m2', 'active');

COMMIT;

SELECT
  'SETUP_PASS' AS status,
  COUNT(*) FILTER (WHERE status = 'active') AS active_users,
  array_agg(user_id ORDER BY user_id) AS user_ids
FROM app.users
WHERE user_id IN (
  'anon:fkshare_20260818_190000_k7m2',
  'acct:fkshare_20260818_190000_k7m2'
);

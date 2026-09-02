-- Run in independent DMC session B while session A remains uncommitted.
-- This statement must remain visibly blocked until session A commits.
BEGIN;

SELECT set_config(
  'app.current_user_id',
  'acct:fkshare_20260818_190000_k7m2',
  true
);
SET LOCAL ROLE diet_app;

WITH started AS MATERIALIZED (
  SELECT
    pg_backend_pid() AS session_b_backend_pid,
    clock_timestamp() AS merge_started_at
),
merged AS MATERIALIZED (
  SELECT
    app.merge_current_account_from_anonymous(
      'anon:fkshare_20260818_190000_k7m2'
    ) AS merge_result
  FROM started
)
SELECT
  'SESSION_B_MERGE_RETURNED' AS status,
  started.session_b_backend_pid,
  started.merge_started_at,
  clock_timestamp() AS merge_returned_at,
  merged.merge_result
FROM started
CROSS JOIN merged;

COMMIT;

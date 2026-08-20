-- Run in DMC session A. Do not close this tab and do not commit yet.
BEGIN;

SELECT set_config(
  'app.current_user_id',
  'anon:fkshare_20260818_190000_k7m2',
  true
);
SET LOCAL ROLE diet_app;

INSERT INTO app.user_events (
  event_id,
  user_id,
  event_type,
  occurred_at,
  payload,
  source,
  idempotency_key,
  status
)
VALUES (
  'fkshare_source_20260818_190000_k7m2',
  'anon:fkshare_20260818_190000_k7m2',
  'check_in',
  clock_timestamp(),
  '{"concurrencyTest":"session-a-before-merge"}'::jsonb,
  'system',
  'fkshare-idempotency-20260818-190000-k7m2',
  'active'
)
RETURNING event_id, user_id, event_type, status, recorded_at;

SELECT
  'SESSION_A_LOCK_HELD_DO_NOT_COMMIT' AS status,
  pg_backend_pid() AS session_a_backend_pid,
  clock_timestamp() AS lock_acquired_at;

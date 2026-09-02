-- Run in the original DMC session A only after session B is visibly blocked.
SELECT
  'SESSION_A_RELEASING_LOCK' AS status,
  pg_backend_pid() AS session_a_backend_pid,
  clock_timestamp() AS session_a_commit_at;

COMMIT;

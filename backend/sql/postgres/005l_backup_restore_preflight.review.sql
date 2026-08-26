-- 005l source inventory and empty-canary preflight. Read only; no row content emitted.
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';

SELECT
  CASE
    WHEN current_database() = 'diet_secretary'
      AND current_setting('ssl') = 'on'
      AND to_regclass('app.backup_recovery_canary_005l') IS NULL
    THEN 'PASS'
    ELSE 'BLOCKED'
  END AS status,
  current_database() = 'diet_secretary' AS expected_database,
  current_setting('ssl') = 'on' AS server_ssl_capable,
  to_regclass('app.backup_recovery_canary_005l') IS NULL AS canary_absent,
  (SELECT count(*)::int
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app'
     AND c.relkind IN ('r', 'p')) AS source_table_count,
  (SELECT count(*)::int
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app') AS source_function_count,
  (SELECT count(*)::int
   FROM pg_constraint c
   JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname = 'app') AS source_constraint_count;

ROLLBACK;

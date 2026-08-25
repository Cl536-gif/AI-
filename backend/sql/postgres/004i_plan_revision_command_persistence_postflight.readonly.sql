-- 004i 部署后只读对象核验；不返回命令ID、用户ID、计划ID或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH table_checks AS (
  SELECT COUNT(*) = 1 AS table_owned_and_rls_enabled
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname = 'plan_revision_commands'
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), column_checks AS (
  SELECT COUNT(*) = 6 AS command_columns_valid
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'plan_revision_commands'
    AND column_name IN (
      'command_id', 'user_id', 'plan_id', 'status', 'created_at', 'updated_at'
    )
), constraint_checks AS (
  SELECT
    COUNT(*) FILTER (WHERE constraint_record.contype = 'p') = 1 AS primary_key_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'f') = 2 AS foreign_keys_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'c') = 3 AS checks_valid
  FROM pg_constraint AS constraint_record
  JOIN pg_class AS class ON class.oid = constraint_record.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'plan_revision_commands'
), policy_checks AS (
  SELECT COUNT(*) = 1 AS select_policy_valid
  FROM pg_policy AS policy
  JOIN pg_class AS class ON class.oid = policy.polrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'plan_revision_commands'
    AND policy.polname = 'plan_revision_commands_select_own'
    AND policy.polcmd = 'r'
), privilege_checks AS (
  SELECT
    has_table_privilege('diet_app', 'app.plan_revision_commands', 'SELECT') AS diet_app_can_select,
    NOT has_table_privilege('diet_app', 'app.plan_revision_commands', 'INSERT,UPDATE,DELETE') AS diet_app_cannot_mutate,
    NOT has_table_privilege('public', 'app.plan_revision_commands', 'SELECT,INSERT,UPDATE,DELETE') AS public_has_no_table_access
), index_checks AS (
  SELECT COUNT(*) = 1 AS user_updated_index_valid
  FROM pg_indexes
  WHERE schemaname = 'app'
    AND tablename = 'plan_revision_commands'
    AND indexname = 'plan_revision_commands_user_updated_idx'
), function_target AS (
  SELECT to_regprocedure(
    'app.record_current_user_plan_revision_command(character varying,character varying,character varying,timestamp with time zone)'
  ) AS function_oid
), function_checks AS (
  SELECT
    function_oid IS NOT NULL AS record_function_present,
    COALESCE(has_function_privilege('diet_app', function_oid, 'EXECUTE'), false)
      AS diet_app_can_execute_function,
    COALESCE(NOT has_function_privilege('public', function_oid, 'EXECUTE'), false)
      AS public_cannot_execute_function
  FROM function_target
), function_security AS (
  SELECT COUNT(*) = 1 AS function_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname = 'record_current_user_plan_revision_command'
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
    AND procedure.provolatile = 'v'
    AND procedure.proconfig @> ARRAY['search_path=pg_catalog, app']::text[]
    AND procedure.prosrc LIKE '%FOR UPDATE%'
    AND procedure.prosrc LIKE '%draft_created%'
    AND procedure.prosrc LIKE '%delivered%'
), row_checks AS (
  SELECT
    COUNT(*) AS command_row_count,
    COUNT(*) FILTER (
      WHERE status NOT IN ('draft_created', 'delivered')
         OR updated_at < created_at
    ) AS invalid_command_row_count
  FROM app.plan_revision_commands
)
SELECT
  CASE
    WHEN table_owned_and_rls_enabled
      AND command_columns_valid
      AND primary_key_valid
      AND foreign_keys_valid
      AND checks_valid
      AND select_policy_valid
      AND diet_app_can_select
      AND diet_app_cannot_mutate
      AND public_has_no_table_access
      AND user_updated_index_valid
      AND record_function_present
      AND diet_app_can_execute_function
      AND public_cannot_execute_function
      AND function_owned_and_secured
      AND invalid_command_row_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS postflight_status,
  table_checks.*,
  column_checks.*,
  constraint_checks.*,
  policy_checks.*,
  privilege_checks.*,
  index_checks.*,
  function_checks.*,
  function_security.*,
  row_checks.*
FROM table_checks,
     column_checks,
     constraint_checks,
     policy_checks,
     privilege_checks,
     index_checks,
     function_checks,
     function_security,
     row_checks;

ROLLBACK;

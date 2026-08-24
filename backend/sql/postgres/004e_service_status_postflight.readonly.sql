-- 004e 部署后只读对象核验；不返回用户ID、服务状态或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH table_checks AS (
  SELECT
    COUNT(*) = 2 AS tables_owned_and_rls_enabled
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname IN (
      'user_service_status',
      'user_service_transitions'
    )
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), constraint_checks AS (
  SELECT COUNT(*) = 7 AS constraints_valid
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS class ON class.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname IN (
      'user_service_status',
      'user_service_transitions'
    )
    AND constraint_row.conname IN (
      'user_service_status_value_chk',
      'user_service_trial_order_chk',
      'user_service_reminder_order_chk',
      'user_service_active_trial_complete_chk',
      'user_service_transition_from_chk',
      'user_service_transition_to_chk',
      'user_service_transition_reason_chk'
    )
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
), policy_checks AS (
  SELECT COUNT(*) = 2 AS select_policies_valid
  FROM pg_policies
  WHERE schemaname = 'app'
    AND policyname IN (
      'user_service_status_select_own',
      'user_service_transitions_select_own'
    )
    AND cmd = 'SELECT'
    AND roles = ARRAY['diet_app']::name[]
), index_checks AS (
  SELECT COUNT(*) = 1 AS transition_index_valid
  FROM pg_indexes
  WHERE schemaname = 'app'
    AND tablename = 'user_service_transitions'
    AND indexname = 'user_service_transitions_user_time_idx'
), function_checks AS (
  SELECT
    to_regprocedure(
      'app.set_current_user_service_status(jsonb,character varying)'
    ) IS NOT NULL AS service_status_function_present,
    has_function_privilege(
      'diet_app',
      'app.set_current_user_service_status(jsonb,character varying)',
      'EXECUTE'
    ) AS diet_app_can_execute_function,
    NOT has_function_privilege(
      'public',
      'app.set_current_user_service_status(jsonb,character varying)',
      'EXECUTE'
    ) AS public_cannot_execute_function
), owner_checks AS (
  SELECT COUNT(*) = 1 AS function_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname = 'set_current_user_service_status'
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
), permission_checks AS (
  SELECT
    has_table_privilege('diet_app', 'app.user_service_status', 'SELECT')
      AND has_table_privilege(
        'diet_app', 'app.user_service_transitions', 'SELECT'
      ) AS diet_app_can_select_service_tables,
    NOT has_table_privilege(
      'diet_app', 'app.user_service_status', 'INSERT,UPDATE,DELETE'
    ) AND NOT has_table_privilege(
      'diet_app', 'app.user_service_transitions', 'INSERT,UPDATE,DELETE'
    ) AS diet_app_cannot_mutate_service_tables
), row_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.user_service_status) AS service_status_row_count,
    (SELECT COUNT(*) FROM app.user_service_transitions)
      AS service_transition_row_count
)
SELECT
  CASE
    WHEN tables_owned_and_rls_enabled
      AND constraints_valid
      AND select_policies_valid
      AND transition_index_valid
      AND service_status_function_present
      AND diet_app_can_execute_function
      AND public_cannot_execute_function
      AND function_owned_and_secured
      AND diet_app_can_select_service_tables
      AND diet_app_cannot_mutate_service_tables
      AND service_status_row_count = 0
      AND service_transition_row_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS postflight_status,
  table_checks.*,
  constraint_checks.*,
  policy_checks.*,
  index_checks.*,
  function_checks.*,
  owner_checks.*,
  permission_checks.*,
  row_checks.*
FROM table_checks, constraint_checks, policy_checks, index_checks,
     function_checks, owner_checks, permission_checks, row_checks;

ROLLBACK;

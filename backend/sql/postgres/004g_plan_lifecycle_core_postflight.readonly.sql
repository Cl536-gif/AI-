-- 004g 部署后只读对象核验；不返回用户ID、计划内容或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH table_checks AS (
  SELECT COUNT(*) = 2 AS tables_owned_and_rls_enabled
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname IN ('user_plan_versions', 'plan_state_transitions')
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), column_checks AS (
  SELECT
    COUNT(*) FILTER (
      WHERE table_name = 'user_plan_versions'
        AND column_name IN (
          'plan_id', 'user_id', 'plan_version', 'status', 'calculation_id',
          'parent_plan_id', 'plan', 'change_reason', 'created_at',
          'activated_at', 'paused_at', 'completed_at'
        )
    ) = 12 AS plan_columns_valid,
    COUNT(*) FILTER (
      WHERE table_name = 'plan_state_transitions'
        AND column_name IN (
          'transition_id', 'plan_id', 'user_id', 'from_status', 'to_status',
          'reason', 'occurred_at'
        )
    ) = 7 AS transition_columns_valid
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name IN ('user_plan_versions', 'plan_state_transitions')
), constraint_checks AS (
  SELECT
    COUNT(*) FILTER (
      WHERE class.relname = 'user_plan_versions'
        AND constraint_row.conname IN (
          'user_plan_versions_pkey',
          'user_plan_versions_user_version_unique',
          'user_plan_versions_user_plan_unique',
          'user_plan_versions_calculation_fk',
          'user_plan_versions_parent_fk',
          'user_plan_versions_status_chk',
          'user_plan_versions_version_chk',
          'user_plan_versions_plan_object_chk',
          'user_plan_versions_change_reason_chk',
          'user_plan_versions_timestamps_chk'
        )
        AND constraint_row.convalidated
    ) = 10 AS plan_constraints_valid,
    COUNT(*) FILTER (
      WHERE class.relname = 'plan_state_transitions'
        AND constraint_row.conname IN (
          'plan_state_transitions_pkey',
          'plan_state_transitions_plan_fk',
          'plan_state_transitions_from_status_chk',
          'plan_state_transitions_to_status_chk',
          'plan_state_transitions_reason_chk'
        )
        AND constraint_row.convalidated
    ) = 5 AS transition_constraints_valid,
    COUNT(*) FILTER (
      WHERE class.relname = 'energy_calculations'
        AND constraint_row.conname =
          'energy_calculations_user_calculation_unique'
        AND constraint_row.contype = 'u'
        AND constraint_row.convalidated
    ) = 1 AS energy_composite_unique_valid
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS class ON class.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname IN (
      'user_plan_versions',
      'plan_state_transitions',
      'energy_calculations'
    )
), policy_checks AS (
  SELECT COUNT(*) = 2 AS select_policies_valid
  FROM pg_policies
  WHERE schemaname = 'app'
    AND policyname IN (
      'user_plan_versions_select_own',
      'plan_state_transitions_select_own'
    )
    AND cmd = 'SELECT'
    AND roles = ARRAY['diet_app']::name[]
), index_checks AS (
  SELECT
    COUNT(*) FILTER (
      WHERE tablename = 'user_plan_versions'
        AND indexname IN (
          'user_plan_versions_one_active_per_user_idx',
          'user_plan_versions_user_version_idx'
        )
    ) = 2 AS plan_indexes_valid,
    COUNT(*) FILTER (
      WHERE tablename = 'plan_state_transitions'
        AND indexname = 'plan_state_transitions_plan_time_idx'
    ) = 1 AS transition_index_valid
  FROM pg_indexes
  WHERE schemaname = 'app'
    AND tablename IN ('user_plan_versions', 'plan_state_transitions')
), function_targets AS (
  SELECT
    to_regprocedure(
      'app.create_current_user_plan_draft(jsonb,timestamp with time zone)'
    ) AS create_function_oid,
    to_regprocedure(
      'app.transition_current_user_plan(character varying,character varying,character varying,timestamp with time zone)'
    ) AS transition_function_oid
), function_checks AS (
  SELECT
    create_function_oid IS NOT NULL
      AND transition_function_oid IS NOT NULL AS functions_present,
    COALESCE(
      has_function_privilege('diet_app', create_function_oid, 'EXECUTE'),
      false
    ) AND COALESCE(
      has_function_privilege('diet_app', transition_function_oid, 'EXECUTE'),
      false
    ) AS diet_app_can_execute_functions,
    COALESCE(
      NOT has_function_privilege('public', create_function_oid, 'EXECUTE'),
      false
    ) AND COALESCE(
      NOT has_function_privilege('public', transition_function_oid, 'EXECUTE'),
      false
    ) AS public_cannot_execute_functions
  FROM function_targets
), owner_checks AS (
  SELECT COUNT(*) = 2 AS functions_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname IN (
      'create_current_user_plan_draft',
      'transition_current_user_plan'
    )
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
    AND procedure.proconfig @> ARRAY['search_path=pg_catalog, app']::text[]
), permission_checks AS (
  SELECT
    has_table_privilege('diet_app', 'app.user_plan_versions', 'SELECT')
      AND has_table_privilege(
        'diet_app', 'app.plan_state_transitions', 'SELECT'
      ) AS diet_app_can_select_plan_tables,
    NOT has_table_privilege(
      'diet_app', 'app.user_plan_versions', 'INSERT,UPDATE,DELETE'
    ) AND NOT has_table_privilege(
      'diet_app', 'app.plan_state_transitions', 'INSERT,UPDATE,DELETE'
    ) AS diet_app_cannot_mutate_plan_tables
), row_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.user_plan_versions) AS plan_row_count,
    (SELECT COUNT(*) FROM app.plan_state_transitions) AS transition_row_count
)
SELECT
  CASE
    WHEN tables_owned_and_rls_enabled
      AND plan_columns_valid
      AND transition_columns_valid
      AND plan_constraints_valid
      AND transition_constraints_valid
      AND energy_composite_unique_valid
      AND select_policies_valid
      AND plan_indexes_valid
      AND transition_index_valid
      AND functions_present
      AND diet_app_can_execute_functions
      AND public_cannot_execute_functions
      AND functions_owned_and_secured
      AND diet_app_can_select_plan_tables
      AND diet_app_cannot_mutate_plan_tables
      AND plan_row_count = 0
      AND transition_row_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS postflight_status,
  table_checks.*,
  column_checks.*,
  constraint_checks.*,
  policy_checks.*,
  index_checks.*,
  function_checks.*,
  owner_checks.*,
  permission_checks.*,
  row_checks.*
FROM table_checks, column_checks, constraint_checks, policy_checks,
     index_checks, function_checks, owner_checks, permission_checks, row_checks;

ROLLBACK;

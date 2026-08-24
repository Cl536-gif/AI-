-- 004f 部署后只读对象核验；不返回用户ID、计算内容或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH table_checks AS (
  SELECT COUNT(*) = 1 AS table_owned_and_rls_enabled
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname = 'energy_calculations'
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), column_checks AS (
  SELECT COUNT(*) = 9 AS columns_valid
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'energy_calculations'
    AND column_name IN (
      'calculation_id',
      'user_id',
      'formula_id',
      'formula_version',
      'inputs',
      'assumptions',
      'outputs',
      'source_refs',
      'created_at'
    )
), constraint_checks AS (
  SELECT COUNT(*) = 6 AS constraints_valid
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS class ON class.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'energy_calculations'
    AND constraint_row.conname IN (
      'energy_calculations_formula_id_chk',
      'energy_calculations_formula_version_chk',
      'energy_calculations_inputs_object_chk',
      'energy_calculations_assumptions_array_chk',
      'energy_calculations_outputs_object_chk',
      'energy_calculations_source_refs_array_chk'
    )
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
), policy_checks AS (
  SELECT COUNT(*) = 1 AS select_policy_valid
  FROM pg_policies
  WHERE schemaname = 'app'
    AND policyname = 'energy_calculations_select_own'
    AND cmd = 'SELECT'
    AND roles = ARRAY['diet_app']::name[]
), index_checks AS (
  SELECT COUNT(*) = 1 AS user_time_index_valid
  FROM pg_indexes
  WHERE schemaname = 'app'
    AND tablename = 'energy_calculations'
    AND indexname = 'energy_calculations_user_time_idx'
), function_target AS (
  SELECT to_regprocedure(
    'app.record_current_user_energy_calculation(jsonb,timestamp with time zone)'
  ) AS function_oid
), function_checks AS (
  SELECT
    function_oid IS NOT NULL AS record_function_present,
    COALESCE(
      has_function_privilege('diet_app', function_oid, 'EXECUTE'),
      false
    ) AS diet_app_can_execute_function,
    COALESCE(
      NOT has_function_privilege('public', function_oid, 'EXECUTE'),
      false
    ) AS public_cannot_execute_function
  FROM function_target
), owner_checks AS (
  SELECT COUNT(*) = 1 AS function_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname = 'record_current_user_energy_calculation'
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
), permission_checks AS (
  SELECT
    has_table_privilege('diet_app', 'app.energy_calculations', 'SELECT')
      AS diet_app_can_select_energy_calculations,
    NOT has_table_privilege(
      'diet_app', 'app.energy_calculations', 'INSERT,UPDATE,DELETE'
    ) AS diet_app_cannot_mutate_energy_calculations
), row_checks AS (
  SELECT COUNT(*) AS energy_calculation_row_count
  FROM app.energy_calculations
)
SELECT
  CASE
    WHEN table_owned_and_rls_enabled
      AND columns_valid
      AND constraints_valid
      AND select_policy_valid
      AND user_time_index_valid
      AND record_function_present
      AND diet_app_can_execute_function
      AND public_cannot_execute_function
      AND function_owned_and_secured
      AND diet_app_can_select_energy_calculations
      AND diet_app_cannot_mutate_energy_calculations
      AND energy_calculation_row_count = 0
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

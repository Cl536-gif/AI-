-- 004g 云端只读前置检查。只返回对象状态和计数，不返回用户或计划数据。
BEGIN;
SET TRANSACTION READ ONLY;

WITH prerequisite_tables AS (
  SELECT COUNT(*) = 3 AS prerequisite_tables_valid
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname IN (
      'users',
      'user_service_status',
      'energy_calculations'
    )
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), target_objects AS (
  SELECT
    to_regclass('app.user_plan_versions') IS NULL
      AS plan_versions_table_absent,
    to_regclass('app.plan_state_transitions') IS NULL
      AS plan_transitions_table_absent,
    to_regprocedure(
      'app.create_current_user_plan_draft(jsonb,timestamp with time zone)'
    ) IS NULL AS create_plan_function_absent,
    to_regprocedure(
      'app.transition_current_user_plan(character varying,character varying,character varying,timestamp with time zone)'
    ) IS NULL AS transition_plan_function_absent
), prerequisite_constraints AS (
  SELECT COUNT(*) = 0 AS energy_composite_unique_absent
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS class ON class.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'energy_calculations'
    AND constraint_row.conname = 'energy_calculations_user_calculation_unique'
), data_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.users) AS existing_user_count,
    (SELECT COUNT(*) FROM app.user_service_status) AS existing_service_status_count,
    (SELECT COUNT(*) FROM app.energy_calculations) AS existing_energy_calculation_count
)
SELECT
  CASE
    WHEN current_database() = 'diet_secretary'
      AND prerequisite_tables_valid
      AND plan_versions_table_absent
      AND plan_transitions_table_absent
      AND create_plan_function_absent
      AND transition_plan_function_absent
      AND energy_composite_unique_absent
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  current_database() = 'diet_secretary' AS database_matched,
  prerequisite_tables.*,
  target_objects.*,
  prerequisite_constraints.*,
  data_checks.*
FROM prerequisite_tables, target_objects, prerequisite_constraints, data_checks;

ROLLBACK;

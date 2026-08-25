-- 004i 云端只读前置检查。只返回对象状态和计数，不返回用户或计划数据。
BEGIN;
SET TRANSACTION READ ONLY;

WITH prerequisite_tables AS (
  SELECT COUNT(*) = 2 AS prerequisite_tables_valid
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname IN ('users', 'user_plan_versions')
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), prerequisite_plan_constraint AS (
  SELECT COUNT(*) = 1 AS user_plan_composite_unique_valid
  FROM pg_constraint AS constraint_record
  JOIN pg_class AS class ON class.oid = constraint_record.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'user_plan_versions'
    AND constraint_record.conname = 'user_plan_versions_user_plan_unique'
    AND constraint_record.contype = 'u'
), prerequisite_functions AS (
  SELECT COUNT(*) = 2 AS prerequisite_functions_valid
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname IN ('current_user_id', 'current_user_is_active')
    AND owner_role.rolname = 'diet_owner'
), target_objects AS (
  SELECT
    to_regclass('app.plan_revision_commands') IS NULL AS command_table_absent,
    to_regprocedure(
      'app.record_current_user_plan_revision_command(character varying,character varying,character varying,timestamp with time zone)'
    ) IS NULL AS record_command_function_absent
), data_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.users) AS existing_user_count,
    (SELECT COUNT(*) FROM app.user_plan_versions) AS existing_plan_count
)
SELECT
  CASE
    WHEN current_database() = 'diet_secretary'
      AND prerequisite_tables_valid
      AND user_plan_composite_unique_valid
      AND prerequisite_functions_valid
      AND command_table_absent
      AND record_command_function_absent
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  current_database() = 'diet_secretary' AS database_matched,
  prerequisite_tables.*,
  prerequisite_plan_constraint.*,
  prerequisite_functions.*,
  target_objects.*,
  data_checks.*
FROM prerequisite_tables,
     prerequisite_plan_constraint,
     prerequisite_functions,
     target_objects,
     data_checks;

ROLLBACK;

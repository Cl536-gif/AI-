-- 004k 云端只读前置检查。只返回对象状态和计数，不返回用户或建议内容。
BEGIN;
SET TRANSACTION READ ONLY;

WITH prerequisite_table AS (
  SELECT COUNT(*) = 1 AS prerequisite_table_valid
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname = 'users'
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
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
    to_regclass('app.user_advice_history') IS NULL AS advice_table_absent,
    to_regprocedure(
      'app.record_current_user_advice(jsonb,timestamp with time zone)'
    ) IS NULL AS record_advice_function_absent
), data_checks AS (
  SELECT COUNT(*) AS existing_user_count FROM app.users
)
SELECT
  CASE
    WHEN current_database() = 'diet_secretary'
      AND prerequisite_table_valid
      AND prerequisite_functions_valid
      AND advice_table_absent
      AND record_advice_function_absent
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  current_database() = 'diet_secretary' AS database_matched,
  prerequisite_table.*,
  prerequisite_functions.*,
  target_objects.*,
  data_checks.*
FROM prerequisite_table,
     prerequisite_functions,
     target_objects,
     data_checks;

ROLLBACK;

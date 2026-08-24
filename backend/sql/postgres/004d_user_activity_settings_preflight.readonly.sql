-- 004d 云端只读前置检查。只返回对象状态和计数，不返回用户ID或设置值。
BEGIN;
SET TRANSACTION READ ONLY;

WITH users_table AS (
  SELECT
    owner_role.rolname = 'diet_owner' AS owner_valid,
    class.relrowsecurity AS rls_enabled
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname = 'users'
    AND class.relkind = 'r'
), baseline_columns AS (
  SELECT COUNT(*) = 5 AS required_columns_present
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'users'
    AND column_name IN (
      'user_id', 'status', 'merged_into_user_id', 'created_at', 'updated_at'
    )
), target_columns AS (
  SELECT COUNT(*) = 0 AS target_columns_absent
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'users'
    AND column_name IN ('last_active_at', 'timezone', 'locale')
), target_objects AS (
  SELECT
    to_regprocedure('app.record_current_user_activity()') IS NULL
      AND to_regprocedure(
        'app.update_current_user_timezone(character varying)'
      ) IS NULL AS target_functions_absent,
    to_regclass('app.users_last_active_idx') IS NULL AS target_index_absent
), permissions AS (
  SELECT
    has_table_privilege('diet_app', 'app.users', 'SELECT')
      AS diet_app_can_select_users,
    has_table_privilege('diet_app', 'app.users', 'INSERT')
      AS diet_app_can_insert_users,
    NOT has_table_privilege('diet_app', 'app.users', 'UPDATE')
      AS diet_app_cannot_update_users_directly
), data_checks AS (
  SELECT
    COUNT(*) AS existing_user_count,
    COUNT(*) FILTER (
      WHERE status NOT IN ('active', 'merged', 'disabled')
    ) AS users_with_unknown_status,
    COUNT(*) FILTER (
      WHERE created_at IS NULL OR updated_at IS NULL
    ) AS users_with_missing_baseline_time
  FROM app.users
)
SELECT
  CASE
    WHEN current_database() = 'diet_secretary'
      AND owner_valid
      AND rls_enabled
      AND required_columns_present
      AND target_columns_absent
      AND target_functions_absent
      AND target_index_absent
      AND diet_app_can_select_users
      AND diet_app_can_insert_users
      AND diet_app_cannot_update_users_directly
      AND users_with_unknown_status = 0
      AND users_with_missing_baseline_time = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  current_database() = 'diet_secretary' AS database_matched,
  users_table.*,
  baseline_columns.*,
  target_columns.*,
  target_objects.*,
  permissions.*,
  data_checks.*
FROM users_table, baseline_columns, target_columns,
     target_objects, permissions, data_checks;

ROLLBACK;


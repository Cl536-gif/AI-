-- 004e 云端只读前置检查。只返回对象状态和计数，不返回用户数据。
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
), users_columns AS (
  SELECT COUNT(*) = 8 AS required_user_columns_present
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'users'
    AND column_name IN (
      'user_id',
      'status',
      'created_at',
      'updated_at',
      'last_active_at',
      'timezone',
      'locale',
      'merged_into_user_id'
    )
), target_objects AS (
  SELECT
    to_regclass('app.user_service_status') IS NULL
      AS service_status_table_absent,
    to_regclass('app.user_service_transitions') IS NULL
      AS service_transitions_table_absent,
    to_regprocedure(
      'app.set_current_user_service_status(jsonb,character varying)'
    ) IS NULL AS service_status_function_absent
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
    ) AS users_with_unknown_account_status,
    COUNT(*) FILTER (
      WHERE created_at IS NULL
        OR updated_at IS NULL
        OR last_active_at IS NULL
    ) AS users_with_missing_required_time
  FROM app.users
)
SELECT
  CASE
    WHEN current_database() = 'diet_secretary'
      AND owner_valid
      AND rls_enabled
      AND required_user_columns_present
      AND service_status_table_absent
      AND service_transitions_table_absent
      AND service_status_function_absent
      AND diet_app_can_select_users
      AND diet_app_can_insert_users
      AND diet_app_cannot_update_users_directly
      AND users_with_unknown_account_status = 0
      AND users_with_missing_required_time = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  current_database() = 'diet_secretary' AS database_matched,
  users_table.*,
  users_columns.*,
  target_objects.*,
  permissions.*,
  data_checks.*
FROM users_table, users_columns, target_objects, permissions, data_checks;

ROLLBACK;

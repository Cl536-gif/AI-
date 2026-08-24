-- 004d 部署后只读对象核验；不返回用户ID、设置值或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH column_checks AS (
  SELECT
    COUNT(*) FILTER (
      WHERE column_name = 'last_active_at'
        AND data_type = 'timestamp with time zone'
        AND is_nullable = 'NO'
    ) = 1 AS last_active_column_valid,
    COUNT(*) FILTER (
      WHERE column_name = 'timezone'
        AND data_type = 'character varying'
        AND character_maximum_length = 64
        AND is_nullable = 'NO'
        AND column_default = '''Asia/Shanghai''::character varying'
    ) = 1 AS timezone_column_valid,
    COUNT(*) FILTER (
      WHERE column_name = 'locale'
        AND data_type = 'character varying'
        AND character_maximum_length = 16
        AND is_nullable = 'NO'
        AND column_default = '''zh-CN''::character varying'
    ) = 1 AS locale_column_valid
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'users'
    AND column_name IN ('last_active_at', 'timezone', 'locale')
), constraint_checks AS (
  SELECT COUNT(*) = 2 AS setting_constraints_valid
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS class ON class.oid = constraint_row.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'users'
    AND constraint_row.conname IN (
      'users_timezone_format_chk',
      'users_locale_format_chk'
    )
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
), index_checks AS (
  SELECT COUNT(*) = 1 AS last_active_index_valid
  FROM pg_indexes
  WHERE schemaname = 'app'
    AND tablename = 'users'
    AND indexname = 'users_last_active_idx'
), function_checks AS (
  SELECT
    to_regprocedure('app.record_current_user_activity()') IS NOT NULL
      AS record_activity_function_present,
    to_regprocedure(
      'app.update_current_user_timezone(character varying)'
    ) IS NOT NULL AS update_timezone_function_present,
    has_function_privilege(
      'diet_app', 'app.record_current_user_activity()', 'EXECUTE'
    ) AS diet_app_can_record_activity,
    has_function_privilege(
      'diet_app',
      'app.update_current_user_timezone(character varying)',
      'EXECUTE'
    ) AS diet_app_can_update_timezone,
    NOT has_function_privilege(
      'public', 'app.record_current_user_activity()', 'EXECUTE'
    ) AS public_cannot_record_activity,
    NOT has_function_privilege(
      'public',
      'app.update_current_user_timezone(character varying)',
      'EXECUTE'
    ) AS public_cannot_update_timezone
), owner_checks AS (
  SELECT COUNT(*) = 2 AS functions_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname IN (
      'record_current_user_activity',
      'update_current_user_timezone'
    )
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
), permission_checks AS (
  SELECT
    NOT has_table_privilege('diet_app', 'app.users', 'UPDATE')
      AS diet_app_cannot_update_users_directly
), data_checks AS (
  SELECT
    COUNT(*) AS existing_user_count,
    COUNT(*) FILTER (WHERE last_active_at IS NULL)
      AS users_missing_last_active_at,
    COUNT(*) FILTER (
      WHERE timezone IS NULL OR char_length(timezone) NOT BETWEEN 1 AND 64
    ) AS users_with_invalid_timezone_shape,
    COUNT(*) FILTER (
      WHERE locale IS NULL
        OR locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    ) AS users_with_invalid_locale_shape
  FROM app.users
)
SELECT
  CASE
    WHEN last_active_column_valid
      AND timezone_column_valid
      AND locale_column_valid
      AND setting_constraints_valid
      AND last_active_index_valid
      AND record_activity_function_present
      AND update_timezone_function_present
      AND diet_app_can_record_activity
      AND diet_app_can_update_timezone
      AND public_cannot_record_activity
      AND public_cannot_update_timezone
      AND functions_owned_and_secured
      AND diet_app_cannot_update_users_directly
      AND users_missing_last_active_at = 0
      AND users_with_invalid_timezone_shape = 0
      AND users_with_invalid_locale_shape = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS postflight_status,
  column_checks.*,
  constraint_checks.*,
  index_checks.*,
  function_checks.*,
  owner_checks.*,
  permission_checks.*,
  data_checks.*
FROM column_checks, constraint_checks, index_checks, function_checks,
     owner_checks, permission_checks, data_checks;

ROLLBACK;

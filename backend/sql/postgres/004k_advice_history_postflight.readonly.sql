-- 004k 部署后只读对象核验；不返回建议ID、用户ID、正文、元数据或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH table_checks AS (
  SELECT COUNT(*) = 1 AS table_owned_and_rls_enabled
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname = 'user_advice_history'
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), column_checks AS (
  SELECT COUNT(*) = 9 AS advice_columns_valid
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'user_advice_history'
    AND column_name IN (
      'advice_id', 'user_id', 'advice_type', 'service_mode', 'content',
      'metadata', 'thread_id', 'idempotency_key', 'created_at'
    )
), constraint_checks AS (
  SELECT
    COUNT(*) FILTER (WHERE constraint_record.contype = 'p') = 1 AS primary_key_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'f') = 1 AS foreign_key_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'u') = 1 AS idempotency_unique_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'c') = 6 AS checks_valid
  FROM pg_constraint AS constraint_record
  JOIN pg_class AS class ON class.oid = constraint_record.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'user_advice_history'
), policy_checks AS (
  SELECT COUNT(*) = 1 AS select_policy_valid
  FROM pg_policy AS policy
  JOIN pg_class AS class ON class.oid = policy.polrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'user_advice_history'
    AND policy.polname = 'user_advice_history_select_own'
    AND policy.polcmd = 'r'
), privilege_checks AS (
  SELECT
    has_table_privilege('diet_app', 'app.user_advice_history', 'SELECT')
      AS diet_app_can_select,
    NOT has_table_privilege(
      'diet_app', 'app.user_advice_history', 'INSERT,UPDATE,DELETE'
    ) AS diet_app_cannot_mutate,
    NOT has_table_privilege(
      'public', 'app.user_advice_history', 'SELECT,INSERT,UPDATE,DELETE'
    ) AS public_has_no_table_access
), index_checks AS (
  SELECT COUNT(*) = 1 AS user_time_index_valid
  FROM pg_indexes
  WHERE schemaname = 'app'
    AND tablename = 'user_advice_history'
    AND indexname = 'user_advice_history_user_time_idx'
), function_target AS (
  SELECT to_regprocedure(
    'app.record_current_user_advice(jsonb,timestamp with time zone)'
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
    AND procedure.proname = 'record_current_user_advice'
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
    AND procedure.provolatile = 'v'
    AND procedure.proconfig @> ARRAY['search_path=pg_catalog, app']::text[]
    AND procedure.prosrc LIKE '%FOR UPDATE%'
    AND procedure.prosrc LIKE '%ON CONFLICT (user_id, idempotency_key)%'
    AND procedure.prosrc LIKE '%jsonb_object_keys%'
), row_checks AS (
  SELECT
    COUNT(*) AS advice_row_count,
    COUNT(*) FILTER (
      WHERE char_length(btrim(content)) = 0
         OR jsonb_typeof(metadata) <> 'object'
         OR char_length(btrim(idempotency_key)) = 0
    ) AS invalid_advice_row_count
  FROM app.user_advice_history
)
SELECT
  CASE
    WHEN table_owned_and_rls_enabled
      AND advice_columns_valid
      AND primary_key_valid
      AND foreign_key_valid
      AND idempotency_unique_valid
      AND checks_valid
      AND select_policy_valid
      AND diet_app_can_select
      AND diet_app_cannot_mutate
      AND public_has_no_table_access
      AND user_time_index_valid
      AND record_function_present
      AND diet_app_can_execute_function
      AND public_cannot_execute_function
      AND function_owned_and_secured
      AND invalid_advice_row_count = 0
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

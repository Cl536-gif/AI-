-- 004j 部署后只读对象核验；不返回用户ID、通知ID、幂等键或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH table_checks AS (
  SELECT COUNT(*) = 1 AS table_owned_and_rls_enabled
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname = 'user_notifications'
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), column_checks AS (
  SELECT COUNT(*) = 9 AS notification_columns_valid
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'user_notifications'
    AND column_name IN (
      'notification_id', 'user_id', 'notification_type', 'dedupe_key',
      'scheduled_at', 'status', 'attempts', 'created_at', 'sent_at'
    )
), constraint_checks AS (
  SELECT
    COUNT(*) FILTER (WHERE constraint_record.contype = 'p') = 1 AS primary_key_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'f') = 1 AS foreign_key_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'u') = 1 AS dedupe_unique_valid,
    COUNT(*) FILTER (WHERE constraint_record.contype = 'c') = 6 AS checks_valid
  FROM pg_constraint AS constraint_record
  JOIN pg_class AS class ON class.oid = constraint_record.conrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'user_notifications'
), policy_checks AS (
  SELECT COUNT(*) = 0 AS no_direct_rls_policy
  FROM pg_policy AS policy
  JOIN pg_class AS class ON class.oid = policy.polrelid
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = 'app'
    AND class.relname = 'user_notifications'
), privilege_checks AS (
  SELECT
    NOT has_table_privilege(
      'diet_app', 'app.user_notifications', 'SELECT,INSERT,UPDATE,DELETE'
    ) AS diet_app_has_no_direct_table_access,
    NOT has_table_privilege(
      'public', 'app.user_notifications', 'SELECT,INSERT,UPDATE,DELETE'
    ) AS public_has_no_table_access
), index_checks AS (
  SELECT COUNT(*) = 1 AS pending_schedule_index_valid
  FROM pg_indexes
  WHERE schemaname = 'app'
    AND tablename = 'user_notifications'
    AND indexname = 'user_notifications_pending_schedule_idx'
), function_targets AS (
  SELECT unnest(ARRAY[
    to_regprocedure(
      'app.enqueue_due_renewal_reminders(timestamp with time zone,integer)'
    ),
    to_regprocedure(
      'app.list_pending_notifications(timestamp with time zone,integer)'
    ),
    to_regprocedure(
      'app.mark_notification_sent(character varying,timestamp with time zone)'
    )
  ]) AS function_oid
), function_privileges AS (
  SELECT
    COUNT(function_oid) = 3 AS functions_present,
    COUNT(*) FILTER (
      WHERE has_function_privilege('diet_app', function_oid, 'EXECUTE')
    ) = 3 AS diet_app_can_execute_functions,
    COUNT(*) FILTER (
      WHERE NOT has_function_privilege('public', function_oid, 'EXECUTE')
    ) = 3 AS public_cannot_execute_functions
  FROM function_targets
), function_security AS (
  SELECT COUNT(*) = 3 AS functions_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname IN (
      'enqueue_due_renewal_reminders',
      'list_pending_notifications',
      'mark_notification_sent'
    )
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
    AND procedure.proconfig @> ARRAY['search_path=pg_catalog, app']::text[]
), definition_checks AS (
  SELECT COUNT(*) = 3 AS queue_definitions_valid
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app'
    AND (
      (procedure.proname = 'enqueue_due_renewal_reminders'
        AND procedure.prosrc LIKE '%trial_active%'
        AND procedure.prosrc LIKE '%trial_ends_at > v_now%'
        AND procedure.prosrc LIKE '%ON CONFLICT%'
        AND procedure.prosrc LIKE '%RETURNING *%'
        AND procedure.prosrc LIKE '%resolved_notifications%')
      OR (procedure.proname = 'list_pending_notifications'
        AND procedure.prosrc LIKE '%status = ''pending''%')
      OR (procedure.proname = 'mark_notification_sent'
        AND procedure.prosrc LIKE '%attempts = attempts + 1%'
        AND procedure.prosrc LIKE '%RETURN FOUND%')
    )
), row_checks AS (
  SELECT
    COUNT(*) AS notification_row_count,
    COUNT(*) FILTER (
      WHERE notification_type <> 'trial_renewal_day_13'
         OR status NOT IN ('pending', 'sent')
         OR attempts < 0
         OR (status = 'pending' AND sent_at IS NOT NULL)
         OR (status = 'sent' AND (sent_at IS NULL OR attempts < 1))
    ) AS invalid_notification_row_count
  FROM app.user_notifications
)
SELECT
  CASE
    WHEN table_owned_and_rls_enabled
      AND notification_columns_valid
      AND primary_key_valid
      AND foreign_key_valid
      AND dedupe_unique_valid
      AND checks_valid
      AND no_direct_rls_policy
      AND diet_app_has_no_direct_table_access
      AND public_has_no_table_access
      AND pending_schedule_index_valid
      AND functions_present
      AND diet_app_can_execute_functions
      AND public_cannot_execute_functions
      AND functions_owned_and_secured
      AND queue_definitions_valid
      AND invalid_notification_row_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS postflight_status,
  table_checks.*,
  column_checks.*,
  constraint_checks.*,
  policy_checks.*,
  privilege_checks.*,
  index_checks.*,
  function_privileges.*,
  function_security.*,
  definition_checks.*,
  row_checks.*
FROM table_checks,
     column_checks,
     constraint_checks,
     policy_checks,
     privilege_checks,
     index_checks,
     function_privileges,
     function_security,
     definition_checks,
     row_checks;

ROLLBACK;

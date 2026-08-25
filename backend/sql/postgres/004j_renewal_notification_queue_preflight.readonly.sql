-- 004j 云端只读前置检查。只返回对象状态和计数，不返回用户或通知数据。
BEGIN;
SET TRANSACTION READ ONLY;

WITH prerequisite_tables AS (
  SELECT COUNT(*) = 2 AS prerequisite_tables_valid
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname IN ('users', 'user_service_status')
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), prerequisite_service_columns AS (
  SELECT COUNT(*) = 5 AS service_columns_valid
  FROM information_schema.columns
  WHERE table_schema = 'app'
    AND table_name = 'user_service_status'
    AND column_name IN (
      'user_id', 'status', 'trial_started_at', 'trial_ends_at', 'renewal_reminder_at'
    )
), target_objects AS (
  SELECT
    to_regclass('app.user_notifications') IS NULL AS notifications_table_absent,
    to_regprocedure(
      'app.enqueue_due_renewal_reminders(timestamp with time zone,integer)'
    ) IS NULL AS enqueue_function_absent,
    to_regprocedure(
      'app.list_pending_notifications(timestamp with time zone,integer)'
    ) IS NULL AS list_function_absent,
    to_regprocedure(
      'app.mark_notification_sent(character varying,timestamp with time zone)'
    ) IS NULL AS mark_sent_function_absent
), data_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.users) AS existing_user_count,
    (SELECT COUNT(*) FROM app.user_service_status) AS existing_service_status_count,
    (
      SELECT COUNT(*)
      FROM app.user_service_status
      WHERE status = 'trial_active'
        AND (
          trial_started_at IS NULL
          OR trial_ends_at IS NULL
          OR renewal_reminder_at IS NULL
        )
    ) AS incomplete_active_trial_count
)
SELECT
  CASE
    WHEN current_database() = 'diet_secretary'
      AND prerequisite_tables_valid
      AND service_columns_valid
      AND notifications_table_absent
      AND enqueue_function_absent
      AND list_function_absent
      AND mark_sent_function_absent
      AND incomplete_active_trial_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  current_database() = 'diet_secretary' AS database_matched,
  prerequisite_tables.*,
  prerequisite_service_columns.*,
  target_objects.*,
  data_checks.*
FROM prerequisite_tables,
     prerequisite_service_columns,
     target_objects,
     data_checks;

ROLLBACK;

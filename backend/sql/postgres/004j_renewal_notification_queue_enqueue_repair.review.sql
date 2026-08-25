-- REVIEW ONLY: 修复004j首次入队时INSERT行在同语句旧快照中不可见的问题。
-- 前置：004j正式迁移已部署，功能沙箱首次执行已回滚。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.enqueue_due_renewal_reminders(
  p_now timestamptz DEFAULT clock_timestamp(),
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_now timestamptz := COALESCE(p_now, clock_timestamp());
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_result jsonb;
BEGIN
  WITH due_users AS MATERIALIZED (
    SELECT
      service.user_id,
      service.renewal_reminder_at,
      'renewal-day-13:' || to_char(
        service.trial_started_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS dedupe_key
    FROM app.user_service_status AS service
    WHERE service.status = 'trial_active'
      AND service.trial_started_at IS NOT NULL
      AND service.renewal_reminder_at IS NOT NULL
      AND service.renewal_reminder_at <= v_now
      AND service.trial_ends_at > v_now
    ORDER BY service.renewal_reminder_at, service.user_id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), inserted AS (
    INSERT INTO app.user_notifications (
      user_id,
      notification_type,
      dedupe_key,
      scheduled_at,
      status,
      attempts,
      created_at,
      sent_at
    )
    SELECT
      due.user_id,
      'trial_renewal_day_13',
      due.dedupe_key,
      due.renewal_reminder_at,
      'pending',
      0,
      v_now,
      NULL
    FROM due_users AS due
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING *
  ), resolved_notifications AS (
    SELECT inserted.*
    FROM inserted
    UNION ALL
    SELECT notification.*
    FROM due_users AS due
    JOIN app.user_notifications AS notification
      ON notification.user_id = due.user_id
     AND notification.dedupe_key = due.dedupe_key
    WHERE NOT EXISTS (
      SELECT 1
      FROM inserted
      WHERE inserted.user_id = due.user_id
        AND inserted.dedupe_key = due.dedupe_key
    )
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'notificationId', notification.notification_id,
        'userId', notification.user_id,
        'notificationType', notification.notification_type,
        'dedupeKey', notification.dedupe_key,
        'scheduledAt', notification.scheduled_at,
        'status', notification.status,
        'attempts', notification.attempts,
        'createdAt', notification.created_at,
        'sentAt', notification.sent_at
      ) ORDER BY notification.scheduled_at, notification.notification_id
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM resolved_notifications AS notification;

  RETURN v_result;
END;
$function$;

ALTER FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer)
OWNER TO diet_owner;
REVOKE ALL ON FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer)
TO diet_app, diet_owner;

COMMENT ON FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer) IS
  '为仍在体验期且已到第13天的用户幂等创建续费提醒；新行通过RETURNING在同语句内返回。';

COMMIT;

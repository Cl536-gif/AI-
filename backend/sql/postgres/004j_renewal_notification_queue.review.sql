-- REVIEW ONLY: 004j 第13天续费提醒与通知队列。
-- 前置：001-004i 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE TABLE app.user_notifications (
  notification_id varchar(128) PRIMARY KEY
    DEFAULT public.gen_random_uuid()::text,
  user_id varchar NOT NULL
    REFERENCES app.users(user_id) ON DELETE CASCADE,
  notification_type varchar(64) NOT NULL,
  dedupe_key varchar(256) NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  CONSTRAINT user_notifications_user_dedupe_unique
    UNIQUE (user_id, dedupe_key),
  CONSTRAINT user_notifications_type_chk CHECK (
    notification_type IN ('trial_renewal_day_13')
  ),
  CONSTRAINT user_notifications_dedupe_chk CHECK (
    char_length(btrim(dedupe_key)) BETWEEN 1 AND 256
  ),
  CONSTRAINT user_notifications_status_chk CHECK (
    status IN ('pending', 'sent')
  ),
  CONSTRAINT user_notifications_attempts_chk CHECK (attempts >= 0),
  CONSTRAINT user_notifications_delivery_chk CHECK (
    (status = 'pending' AND sent_at IS NULL)
    OR (status = 'sent' AND sent_at IS NOT NULL AND attempts >= 1)
  ),
  CONSTRAINT user_notifications_time_chk CHECK (
    created_at >= scheduled_at
    AND (sent_at IS NULL OR sent_at >= scheduled_at)
  )
);

CREATE INDEX user_notifications_pending_schedule_idx
  ON app.user_notifications (scheduled_at, notification_id)
  WHERE status = 'pending';

ALTER TABLE app.user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_notifications NO FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app.user_notifications FROM PUBLIC, diet_app;

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

CREATE OR REPLACE FUNCTION app.list_pending_notifications(
  p_now timestamptz DEFAULT clock_timestamp(),
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'notificationId', pending.notification_id,
        'userId', pending.user_id,
        'notificationType', pending.notification_type,
        'dedupeKey', pending.dedupe_key,
        'scheduledAt', pending.scheduled_at,
        'status', pending.status,
        'attempts', pending.attempts,
        'createdAt', pending.created_at,
        'sentAt', pending.sent_at
      ) ORDER BY pending.scheduled_at, pending.notification_id
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT notification.*
    FROM app.user_notifications AS notification
    WHERE notification.status = 'pending'
      AND notification.scheduled_at <= COALESCE(p_now, statement_timestamp())
    ORDER BY notification.scheduled_at, notification.notification_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ) AS pending;
$function$;

CREATE OR REPLACE FUNCTION app.mark_notification_sent(
  p_notification_id varchar,
  p_sent_at timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_notification_id varchar := NULLIF(btrim(p_notification_id), '');
  v_sent_at timestamptz := COALESCE(p_sent_at, clock_timestamp());
BEGIN
  IF v_notification_id IS NULL OR char_length(v_notification_id) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '提醒ID格式不正确';
  END IF;

  UPDATE app.user_notifications
  SET status = 'sent',
      sent_at = v_sent_at,
      attempts = attempts + 1
  WHERE notification_id = v_notification_id
    AND status = 'pending'
    AND v_sent_at >= scheduled_at;

  RETURN FOUND;
END;
$function$;

ALTER FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer)
OWNER TO diet_owner;
ALTER FUNCTION app.list_pending_notifications(timestamptz, integer)
OWNER TO diet_owner;
ALTER FUNCTION app.mark_notification_sent(varchar, timestamptz)
OWNER TO diet_owner;

REVOKE ALL ON FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer)
FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_pending_notifications(timestamptz, integer)
FROM PUBLIC;
REVOKE ALL ON FUNCTION app.mark_notification_sent(varchar, timestamptz)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer)
TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.list_pending_notifications(timestamptz, integer)
TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.mark_notification_sent(varchar, timestamptz)
TO diet_app, diet_owner;

COMMENT ON TABLE app.user_notifications IS
  '后台通知待发送队列；业务角色不能直接访问，只能通过受控函数操作。';
COMMENT ON FUNCTION app.enqueue_due_renewal_reminders(timestamptz, integer) IS
  '为仍在体验期且已到第13天的用户幂等创建续费提醒。';
COMMENT ON FUNCTION app.list_pending_notifications(timestamptz, integer) IS
  '按计划发送时间读取全局待发送通知队列。';
COMMENT ON FUNCTION app.mark_notification_sent(varchar, timestamptz) IS
  '仅将pending通知确认一次为sent；重复确认返回false。';

COMMIT;

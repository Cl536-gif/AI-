-- 004j 云端功能沙箱。所有业务写入均在同一事务中并最终 ROLLBACK。
-- 固定测试ID仅用于零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004j_verify_a', 'acct:004j_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004j固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004j_verify_a', true);
SET LOCAL ROLE diet_app;

DO $prepare_active_trial$
BEGIN
  PERFORM app.set_current_user_service_status(
    '{
      "status":"trial_active",
      "trialStartedAt":"2026-08-01T00:00:00Z",
      "trialEndsAt":"2026-08-15T00:00:00Z",
      "renewalReminderAt":"2026-08-14T00:00:00Z",
      "officialPlanId":"004j-sandbox-plan-a"
    }'::jsonb,
    '004j_sandbox_trial_a'
  );
END
$prepare_active_trial$;

DO $assert_not_due_early$
DECLARE
  v_early jsonb;
BEGIN
  v_early := app.enqueue_due_renewal_reminders(
    '2026-08-13T23:59:59Z'::timestamptz,
    100
  );
  IF jsonb_array_length(v_early) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004j提醒被提前创建';
  END IF;
END
$assert_not_due_early$;

SELECT 'PASS' AS reminder_not_enqueued_early;

DO $assert_due_and_idempotent$
DECLARE
  v_due jsonb;
  v_repeated jsonb;
  v_notification_id varchar;
BEGIN
  v_due := app.enqueue_due_renewal_reminders(
    '2026-08-14T00:00:00Z'::timestamptz,
    100
  );
  v_repeated := app.enqueue_due_renewal_reminders(
    '2026-08-14T01:00:00Z'::timestamptz,
    100
  );
  v_notification_id := v_due->0->>'notificationId';
  PERFORM set_config('app.verify_004j_notification', v_notification_id, true);

  IF jsonb_array_length(v_due) <> 1
     OR jsonb_array_length(v_repeated) <> 1
     OR v_notification_id IS NULL
     OR v_repeated->0->>'notificationId' <> v_notification_id
     OR v_due->0->>'notificationType' <> 'trial_renewal_day_13'
     OR v_due->0->>'status' <> 'pending'
     OR (v_due->0->>'attempts')::integer <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004j到期入队或幂等重试断言失败';
  END IF;
END
$assert_due_and_idempotent$;

SELECT 'PASS' AS due_reminder_enqueued_idempotently;

DO $assert_pending_queue_and_direct_access_denied$
DECLARE
  v_pending jsonb;
  v_error_code varchar;
BEGIN
  v_pending := app.list_pending_notifications(
    '2026-08-14T01:00:00Z'::timestamptz,
    100
  );
  IF jsonb_array_length(v_pending) <> 1
     OR v_pending->0->>'notificationId'
       <> current_setting('app.verify_004j_notification') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004j待发送队列读取断言失败';
  END IF;

  BEGIN
    PERFORM COUNT(*) FROM app.user_notifications;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'diet_app获得了通知表直接读取权限';
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_error_code = RETURNED_SQLSTATE;
  END;

  IF v_error_code <> '42501' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004j通知表直接访问权限断言失败';
  END IF;
END
$assert_pending_queue_and_direct_access_denied$;

SELECT 'PASS' AS pending_queue_and_rpc_only_access_verified;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004j_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_expired_trial_skipped$
DECLARE
  v_after_expiry jsonb;
BEGIN
  PERFORM app.set_current_user_service_status(
    '{
      "status":"trial_active",
      "trialStartedAt":"2026-07-31T12:00:00Z",
      "trialEndsAt":"2026-08-14T12:00:00Z",
      "renewalReminderAt":"2026-08-13T12:00:00Z",
      "officialPlanId":"004j-sandbox-plan-b"
    }'::jsonb,
    '004j_sandbox_trial_b'
  );

  v_after_expiry := app.enqueue_due_renewal_reminders(
    '2026-08-14T13:00:00Z'::timestamptz,
    100
  );
  IF jsonb_array_length(v_after_expiry) <> 1
     OR v_after_expiry->0->>'userId' <> 'acct:004j_verify_a' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004j到期体验跳过断言失败';
  END IF;
END
$assert_expired_trial_skipped$;

SELECT 'PASS' AS expired_trial_skipped;

DO $assert_mark_sent_once$
DECLARE
  v_notification_id varchar := current_setting('app.verify_004j_notification');
  v_first boolean;
  v_second boolean;
  v_pending jsonb;
BEGIN
  v_first := app.mark_notification_sent(
    v_notification_id,
    '2026-08-14T13:01:00Z'::timestamptz
  );
  v_second := app.mark_notification_sent(
    v_notification_id,
    '2026-08-14T13:02:00Z'::timestamptz
  );
  v_pending := app.list_pending_notifications(
    '2026-08-14T14:00:00Z'::timestamptz,
    100
  );

  IF NOT v_first OR v_second OR jsonb_array_length(v_pending) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004j发送确认幂等断言失败';
  END IF;
END
$assert_mark_sent_once$;

SELECT 'PASS' AS notification_marked_sent_once;

RESET ROLE;
ROLLBACK;

SELECT
  CASE
    WHEN remaining_users = 0
      AND remaining_service_status = 0
      AND remaining_service_transitions = 0
      AND remaining_notifications = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS cleanup_status,
  cleanup.*
FROM (
  SELECT
    (SELECT COUNT(*) FROM app.users
     WHERE user_id IN ('acct:004j_verify_a', 'acct:004j_verify_b')) AS remaining_users,
    (SELECT COUNT(*) FROM app.user_service_status
     WHERE user_id IN ('acct:004j_verify_a', 'acct:004j_verify_b')) AS remaining_service_status,
    (SELECT COUNT(*) FROM app.user_service_transitions
     WHERE user_id IN ('acct:004j_verify_a', 'acct:004j_verify_b')) AS remaining_service_transitions,
    (SELECT COUNT(*) FROM app.user_notifications
     WHERE user_id IN ('acct:004j_verify_a', 'acct:004j_verify_b')) AS remaining_notifications
) AS cleanup;

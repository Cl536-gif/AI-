-- 004e 云端功能沙箱。所有业务写入均在同一事务中并最终 ROLLBACK。
-- 固定测试ID仅用于回滚后的零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004e_verify_a', 'acct:004e_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004e固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004e_verify_a', true);
SET LOCAL ROLE diet_app;

SELECT app.set_current_user_service_status(
  '{"status":"onboarding_incomplete"}'::jsonb,
  'long_term_selected'
) AS onboarding_result;

SELECT app.set_current_user_service_status(
  '{"status":"profile_confirmed"}'::jsonb,
  'profile_confirmed_by_user'
) AS profile_confirmed_result;

SELECT app.set_current_user_service_status(
  '{
    "status":"trial_active",
    "trialStartedAt":"2026-08-24T08:30:00Z",
    "trialEndsAt":"2026-09-07T08:30:00Z",
    "renewalReminderAt":"2026-09-06T08:30:00Z",
    "officialPlanId":"plan-004e-verify"
  }'::jsonb,
  'first_official_plan_delivered'
) AS trial_active_result;

DO $assert_sequence_and_history$
DECLARE
  v_status varchar;
  v_started timestamptz;
  v_ends timestamptz;
  v_reminder timestamptz;
  v_plan_id varchar;
  v_transition_count integer;
  v_sequence text;
BEGIN
  SELECT
    status,
    trial_started_at,
    trial_ends_at,
    renewal_reminder_at,
    official_plan_id
  INTO
    v_status,
    v_started,
    v_ends,
    v_reminder,
    v_plan_id
  FROM app.user_service_status
  WHERE user_id = 'acct:004e_verify_a';

  SELECT
    COUNT(*),
    string_agg(
      COALESCE(from_status, 'NULL') || '>' || to_status,
      ',' ORDER BY occurred_at, transition_id
    )
  INTO v_transition_count, v_sequence
  FROM app.user_service_transitions
  WHERE user_id = 'acct:004e_verify_a';

  IF v_status <> 'trial_active'
     OR v_started <> '2026-08-24T08:30:00Z'::timestamptz
     OR v_ends <> '2026-09-07T08:30:00Z'::timestamptz
     OR v_reminder <> '2026-09-06T08:30:00Z'::timestamptz
     OR v_plan_id <> 'plan-004e-verify'
     OR v_transition_count <> 3
     OR v_sequence <> (
       'NULL>onboarding_incomplete,' ||
       'onboarding_incomplete>profile_confirmed,' ||
       'profile_confirmed>trial_active'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004e状态序列或转换历史断言失败';
  END IF;
END
$assert_sequence_and_history$;

SELECT 'PASS' AS status_sequence_and_history_verified;

DO $assert_invalid_payloads$
DECLARE
  v_status varchar;
  v_transition_count integer;
BEGIN
  BEGIN
    PERFORM app.set_current_user_service_status(
      '{"status":"subscribed","unexpected":true}'::jsonb,
      'invalid_unknown_field'
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '未知字段未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM app.set_current_user_service_status(
      '{
        "status":"trial_active",
        "trialStartedAt":"2026-09-07T08:30:00Z",
        "trialEndsAt":"2026-08-24T08:30:00Z",
        "renewalReminderAt":"2026-09-06T08:30:00Z",
        "officialPlanId":"plan-invalid"
      }'::jsonb,
      'invalid_time_order'
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '倒置体验周期未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  SELECT status INTO v_status
  FROM app.user_service_status
  WHERE user_id = 'acct:004e_verify_a';

  SELECT COUNT(*) INTO v_transition_count
  FROM app.user_service_transitions
  WHERE user_id = 'acct:004e_verify_a';

  IF v_status <> 'trial_active' OR v_transition_count <> 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '非法输入路径修改了服务状态或历史';
  END IF;
END
$assert_invalid_payloads$;

SELECT 'PASS' AS invalid_payloads_rejected_without_mutation;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004e_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_cross_user_isolation$
BEGIN
  IF (SELECT COUNT(*) FROM app.user_service_status
      WHERE user_id = 'acct:004e_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.user_service_transitions
         WHERE user_id = 'acct:004e_verify_a') <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004e跨用户服务状态隔离失败';
  END IF;
END
$assert_cross_user_isolation$;

SELECT 'PASS' AS cross_user_rls_isolation;

RESET ROLE;
ROLLBACK;

SELECT
  CASE WHEN
    (SELECT COUNT(*) FROM app.users
      WHERE user_id IN ('acct:004e_verify_a', 'acct:004e_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.user_service_status
      WHERE user_id = 'acct:004e_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.user_service_transitions
      WHERE user_id = 'acct:004e_verify_a') = 0
  THEN 'PASS' ELSE 'FAIL' END AS rollback_cleanup_status;

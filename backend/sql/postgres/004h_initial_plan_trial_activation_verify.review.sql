-- 004h 云端功能沙箱。所有业务写入均在同一事务中并最终 ROLLBACK。
-- 固定测试ID仅用于回滚后的零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004h_verify_a', 'acct:004h_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004h固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004h_verify_a', true);
SET LOCAL ROLE diet_app;

DO $activate_valid_initial_plan$
DECLARE
  v_calculation jsonb;
  v_plan jsonb;
  v_activated jsonb;
  v_plan_id varchar;
  v_plan_status varchar;
  v_activated_at timestamptz;
  v_service_status varchar;
  v_trial_started_at timestamptz;
  v_trial_ends_at timestamptz;
  v_reminder_at timestamptz;
  v_official_plan_id varchar;
  v_plan_transition_count integer;
  v_service_transition_count integer;
BEGIN
  v_calculation := app.record_current_user_energy_calculation(
    '{
      "formulaId":"FAO_WHO_UNU_SCHOFIELD_BMR_X_CHINA_PAL",
      "formulaVersion":"1.0.0",
      "inputs":{"equationSex":"female","ageYears":22},
      "assumptions":[],
      "outputs":{"estimatedTeeKcalPerDay":2063.5},
      "sourceRefs":[]
    }'::jsonb,
    '2026-08-24T08:00:00Z'::timestamptz
  );

  PERFORM app.set_current_user_service_status(
    '{"status":"onboarding_incomplete"}'::jsonb,
    '004h_sandbox_started'
  );
  PERFORM app.set_current_user_service_status(
    '{"status":"profile_confirmed"}'::jsonb,
    '004h_profile_confirmed'
  );

  v_plan := app.create_current_user_plan_draft(
    jsonb_build_object(
      'calculationId', v_calculation->>'calculationId',
      'plan', jsonb_build_object(
        'energyCalculationId', v_calculation->>'calculationId',
        'dailyEnergyKcal', 2064,
        'label', '004h-initial'
      ),
      'changeReason', 'initial_plan'
    ),
    '2026-08-24T08:05:00Z'::timestamptz
  );
  v_plan_id := v_plan->>'planId';
  PERFORM set_config('app.verify_004h_plan_a', v_plan_id, true);

  v_activated := app.activate_current_user_initial_plan_and_trial(
    v_plan_id,
    '2026-08-24T08:10:00Z'::timestamptz,
    '2026-09-07T08:10:00Z'::timestamptz,
    '2026-09-06T08:10:00Z'::timestamptz
  );

  SELECT status, activated_at
  INTO v_plan_status, v_activated_at
  FROM app.user_plan_versions
  WHERE user_id = 'acct:004h_verify_a' AND plan_id = v_plan_id;

  SELECT
    status,
    trial_started_at,
    trial_ends_at,
    renewal_reminder_at,
    official_plan_id
  INTO
    v_service_status,
    v_trial_started_at,
    v_trial_ends_at,
    v_reminder_at,
    v_official_plan_id
  FROM app.user_service_status
  WHERE user_id = 'acct:004h_verify_a';

  SELECT COUNT(*) INTO v_plan_transition_count
  FROM app.plan_state_transitions
  WHERE user_id = 'acct:004h_verify_a' AND plan_id = v_plan_id;

  SELECT COUNT(*) INTO v_service_transition_count
  FROM app.user_service_transitions
  WHERE user_id = 'acct:004h_verify_a';

  IF v_activated->>'status' <> 'active'
     OR v_plan_status <> 'active'
     OR v_activated_at <> '2026-08-24T08:10:00Z'::timestamptz
     OR v_service_status <> 'trial_active'
     OR v_trial_started_at <> '2026-08-24T08:10:00Z'::timestamptz
     OR v_trial_ends_at <> '2026-09-07T08:10:00Z'::timestamptz
     OR v_reminder_at <> '2026-09-06T08:10:00Z'::timestamptz
     OR v_official_plan_id <> v_plan_id
     OR v_plan_transition_count <> 2
     OR v_service_transition_count <> 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004h计划、体验或转换历史原子激活断言失败';
  END IF;
END
$activate_valid_initial_plan$;

SELECT 'PASS' AS atomic_activation_and_histories_verified;

DO $assert_idempotent_retry$
DECLARE
  v_plan_id varchar := current_setting('app.verify_004h_plan_a');
  v_result jsonb;
  v_plan_transition_count integer;
  v_service_transition_count integer;
BEGIN
  v_result := app.activate_current_user_initial_plan_and_trial(
    v_plan_id,
    '2026-08-24T08:10:00Z'::timestamptz,
    '2026-09-07T08:10:00Z'::timestamptz,
    '2026-09-06T08:10:00Z'::timestamptz
  );

  SELECT COUNT(*) INTO v_plan_transition_count
  FROM app.plan_state_transitions
  WHERE user_id = 'acct:004h_verify_a' AND plan_id = v_plan_id;

  SELECT COUNT(*) INTO v_service_transition_count
  FROM app.user_service_transitions
  WHERE user_id = 'acct:004h_verify_a';

  IF v_result->>'status' <> 'active'
     OR v_plan_transition_count <> 2
     OR v_service_transition_count <> 3 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004h幂等重试新增了转换历史或改变了状态';
  END IF;
END
$assert_idempotent_retry$;

SELECT 'PASS' AS idempotent_retry_verified;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004h_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_invalid_activation_rollback$
DECLARE
  v_calculation jsonb;
  v_plan jsonb;
  v_plan_id varchar;
  v_error_code varchar;
  v_plan_status varchar;
  v_service_status varchar;
  v_plan_transition_count integer;
  v_service_transition_count integer;
BEGIN
  v_calculation := app.record_current_user_energy_calculation(
    '{
      "formulaId":"FAO_WHO_UNU_SCHOFIELD_BMR_X_CHINA_PAL",
      "formulaVersion":"1.0.0",
      "inputs":{"equationSex":"male","ageYears":30},
      "assumptions":[],
      "outputs":{"estimatedTeeKcalPerDay":2450},
      "sourceRefs":[]
    }'::jsonb,
    '2026-08-24T09:00:00Z'::timestamptz
  );

  PERFORM app.set_current_user_service_status(
    '{"status":"onboarding_incomplete"}'::jsonb,
    '004h_invalid_sandbox_started'
  );
  PERFORM app.set_current_user_service_status(
    '{"status":"profile_confirmed"}'::jsonb,
    '004h_invalid_profile_confirmed'
  );

  v_plan := app.create_current_user_plan_draft(
    jsonb_build_object(
      'calculationId', v_calculation->>'calculationId',
      'plan', jsonb_build_object(
        'energyCalculationId', v_calculation->>'calculationId',
        'label', '004h-invalid'
      ),
      'changeReason', 'invalid_time_test'
    ),
    '2026-08-24T09:05:00Z'::timestamptz
  );
  v_plan_id := v_plan->>'planId';

  BEGIN
    PERFORM app.activate_current_user_initial_plan_and_trial(
      v_plan_id,
      '2026-08-24T09:04:00Z'::timestamptz,
      '2026-09-07T09:04:00Z'::timestamptz,
      '2026-09-06T09:04:00Z'::timestamptz
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '早于计划创建时间的体验启动未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      GET STACKED DIAGNOSTICS v_error_code = RETURNED_SQLSTATE;
  END;

  SELECT status INTO v_plan_status
  FROM app.user_plan_versions
  WHERE user_id = 'acct:004h_verify_b' AND plan_id = v_plan_id;

  SELECT status INTO v_service_status
  FROM app.user_service_status
  WHERE user_id = 'acct:004h_verify_b';

  SELECT COUNT(*) INTO v_plan_transition_count
  FROM app.plan_state_transitions
  WHERE user_id = 'acct:004h_verify_b' AND plan_id = v_plan_id;

  SELECT COUNT(*) INTO v_service_transition_count
  FROM app.user_service_transitions
  WHERE user_id = 'acct:004h_verify_b';

  IF v_error_code <> '22023'
     OR v_plan_status <> 'draft'
     OR v_service_status <> 'profile_confirmed'
     OR v_plan_transition_count <> 1
     OR v_service_transition_count <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004h非法激活路径留下了部分写入';
  END IF;
END
$assert_invalid_activation_rollback$;

SELECT 'PASS' AS invalid_activation_rolled_back;

DO $assert_cross_user_isolation$
BEGIN
  IF (SELECT COUNT(*) FROM app.user_plan_versions
      WHERE user_id = 'acct:004h_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.plan_state_transitions
         WHERE user_id = 'acct:004h_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.user_service_status
         WHERE user_id = 'acct:004h_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.user_service_transitions
         WHERE user_id = 'acct:004h_verify_a') <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004h跨用户计划或体验状态隔离失败';
  END IF;
END
$assert_cross_user_isolation$;

SELECT 'PASS' AS cross_user_rls_isolation;

RESET ROLE;
ROLLBACK;

SELECT
  CASE WHEN
    (SELECT COUNT(*) FROM app.users
      WHERE user_id IN ('acct:004h_verify_a', 'acct:004h_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.user_service_status
      WHERE user_id IN ('acct:004h_verify_a', 'acct:004h_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.user_service_transitions
      WHERE user_id IN ('acct:004h_verify_a', 'acct:004h_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.energy_calculations
      WHERE user_id IN ('acct:004h_verify_a', 'acct:004h_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.user_plan_versions
      WHERE user_id IN ('acct:004h_verify_a', 'acct:004h_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.plan_state_transitions
      WHERE user_id IN ('acct:004h_verify_a', 'acct:004h_verify_b')) = 0
  THEN 'PASS' ELSE 'FAIL' END AS rollback_cleanup_status;

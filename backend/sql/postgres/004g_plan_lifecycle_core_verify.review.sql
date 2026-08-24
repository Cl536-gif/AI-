-- 004g 云端功能沙箱。所有业务写入均在同一事务中并最终 ROLLBACK。
-- 固定测试ID仅用于回滚后的零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004g_verify_a', 'acct:004g_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004g固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004g_verify_a', true);
SET LOCAL ROLE diet_app;

DO $verify_plan_lifecycle$
DECLARE
  v_calculation jsonb;
  v_calculation_id varchar;
  v_first_plan jsonb;
  v_first_plan_id varchar;
  v_second_plan jsonb;
  v_second_plan_id varchar;
  v_plan_count integer;
  v_active_count integer;
  v_transition_count integer;
  v_first_status varchar;
  v_first_completed_at timestamptz;
  v_second_status varchar;
  v_second_parent_id varchar;
  v_second_version integer;
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
  v_calculation_id := v_calculation->>'calculationId';

  v_first_plan := app.create_current_user_plan_draft(
    jsonb_build_object(
      'calculationId', v_calculation_id,
      'plan', jsonb_build_object(
        'energyCalculationId', v_calculation_id,
        'dailyEnergyKcal', 2064,
        'label', '004g-v1'
      ),
      'changeReason', 'initial_plan'
    ),
    '2026-08-24T08:05:00Z'::timestamptz
  );
  v_first_plan_id := v_first_plan->>'planId';

  PERFORM app.set_current_user_service_status(
    '{"status":"onboarding_incomplete"}'::jsonb,
    '004g_sandbox_started'
  );
  PERFORM app.set_current_user_service_status(
    '{"status":"profile_confirmed"}'::jsonb,
    '004g_profile_confirmed'
  );
  PERFORM app.set_current_user_service_status(
    '{
      "status":"trial_active",
      "trialStartedAt":"2026-08-24T08:09:00Z",
      "trialEndsAt":"2026-09-07T08:09:00Z",
      "renewalReminderAt":"2026-09-06T08:09:00Z",
      "officialPlanId":"plan-004g-sandbox"
    }'::jsonb,
    '004g_enable_generic_activation'
  );

  PERFORM app.transition_current_user_plan(
    v_first_plan_id,
    'active',
    'initial_activation',
    '2026-08-24T08:10:00Z'::timestamptz
  );
  PERFORM app.transition_current_user_plan(
    v_first_plan_id,
    'paused',
    'prepare_revision',
    '2026-08-24T08:20:00Z'::timestamptz
  );

  v_second_plan := app.create_current_user_plan_draft(
    jsonb_build_object(
      'calculationId', v_calculation_id,
      'parentPlanId', v_first_plan_id,
      'plan', jsonb_build_object(
        'energyCalculationId', v_calculation_id,
        'dailyEnergyKcal', 1980,
        'label', '004g-v2'
      ),
      'changeReason', 'energy_adjustment'
    ),
    '2026-08-24T08:30:00Z'::timestamptz
  );
  v_second_plan_id := v_second_plan->>'planId';

  PERFORM app.transition_current_user_plan(
    v_second_plan_id,
    'active',
    'activate_revision',
    '2026-08-24T08:40:00Z'::timestamptz
  );

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'active')
  INTO v_plan_count, v_active_count
  FROM app.user_plan_versions
  WHERE user_id = 'acct:004g_verify_a';

  SELECT status, completed_at
  INTO v_first_status, v_first_completed_at
  FROM app.user_plan_versions
  WHERE user_id = 'acct:004g_verify_a' AND plan_id = v_first_plan_id;

  SELECT status, parent_plan_id, plan_version
  INTO v_second_status, v_second_parent_id, v_second_version
  FROM app.user_plan_versions
  WHERE user_id = 'acct:004g_verify_a' AND plan_id = v_second_plan_id;

  SELECT COUNT(*) INTO v_transition_count
  FROM app.plan_state_transitions
  WHERE user_id = 'acct:004g_verify_a';

  IF v_calculation_id IS NULL
     OR v_plan_count <> 2
     OR v_active_count <> 1
     OR v_first_status <> 'superseded'
     OR v_first_completed_at <> '2026-08-24T08:40:00Z'::timestamptz
     OR v_second_status <> 'active'
     OR v_second_parent_id <> v_first_plan_id
     OR v_second_version <> 2
     OR v_transition_count <> 6 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004g计划版本、状态机或转换历史断言失败';
  END IF;

  BEGIN
    PERFORM app.transition_current_user_plan(
      v_second_plan_id,
      'active',
      'invalid_repeat_activation',
      '2026-08-24T08:50:00Z'::timestamptz
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '重复active转换未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM app.create_current_user_plan_draft(
      jsonb_build_object(
        'calculationId', v_calculation_id,
        'plan', jsonb_build_object(
          'energyCalculationId', 'mismatched-calculation',
          'label', 'invalid'
        ),
        'changeReason', 'invalid_mismatch'
      ),
      '2026-08-24T09:00:00Z'::timestamptz
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '计划内外计算记录不一致未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  IF (SELECT COUNT(*) FROM app.user_plan_versions
      WHERE user_id = 'acct:004g_verify_a') <> 2
     OR (SELECT COUNT(*) FROM app.plan_state_transitions
         WHERE user_id = 'acct:004g_verify_a') <> 6 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004g非法输入路径修改了计划或历史';
  END IF;
END
$verify_plan_lifecycle$;

SELECT 'PASS' AS plan_version_state_machine_and_invalid_paths_verified;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004g_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_cross_user_isolation$
BEGIN
  IF (SELECT COUNT(*) FROM app.user_plan_versions
      WHERE user_id = 'acct:004g_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.plan_state_transitions
         WHERE user_id = 'acct:004g_verify_a') <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004g跨用户计划隔离失败';
  END IF;
END
$assert_cross_user_isolation$;

SELECT 'PASS' AS cross_user_rls_isolation;

RESET ROLE;
ROLLBACK;

SELECT
  CASE WHEN
    (SELECT COUNT(*) FROM app.users
      WHERE user_id IN ('acct:004g_verify_a', 'acct:004g_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.user_service_status
      WHERE user_id = 'acct:004g_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.user_service_transitions
      WHERE user_id = 'acct:004g_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.energy_calculations
      WHERE user_id = 'acct:004g_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.user_plan_versions
      WHERE user_id = 'acct:004g_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.plan_state_transitions
      WHERE user_id = 'acct:004g_verify_a') = 0
  THEN 'PASS' ELSE 'FAIL' END AS rollback_cleanup_status;

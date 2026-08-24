-- REVIEW ONLY: 004h 首个正式计划与14天体验原子激活。
-- 前置：001-004g 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.activate_current_user_initial_plan_and_trial(
  p_plan_id varchar,
  p_trial_started_at timestamptz,
  p_trial_ends_at timestamptz,
  p_renewal_reminder_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_plan_id varchar := NULLIF(btrim(p_plan_id), '');
  v_account_status varchar;
  v_plan app.user_plan_versions%ROWTYPE;
  v_service app.user_service_status%ROWTYPE;
  v_saved app.user_plan_versions%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF v_plan_id IS NULL OR char_length(v_plan_id) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '正式计划ID格式不正确';
  END IF;

  IF p_trial_started_at IS NULL
     OR p_trial_ends_at IS NULL
     OR p_renewal_reminder_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '体验周期时间不完整';
  END IF;

  IF p_trial_ends_at <= p_trial_started_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '体验结束时间必须晚于开始时间';
  END IF;

  IF p_trial_ends_at <> p_trial_started_at + interval '336 hours' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '首个体验周期必须固定为14天';
  END IF;

  IF p_renewal_reminder_at < p_trial_started_at
     OR p_renewal_reminder_at >= p_trial_ends_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '续费提醒时间必须位于体验周期内';
  END IF;

  IF p_renewal_reminder_at <> p_trial_started_at + interval '312 hours' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '续费提醒必须安排在体验第13天';
  END IF;

  SELECT users.status
  INTO v_account_status
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  SELECT * INTO v_plan
  FROM app.user_plan_versions
  WHERE user_id = v_user_id AND plan_id = v_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '正式计划不存在或不属于当前用户';
  END IF;

  SELECT * INTO v_service
  FROM app.user_service_status
  WHERE user_id = v_user_id
  FOR UPDATE;

  IF v_plan.status = 'active'
     AND v_service.status = 'trial_active'
     AND v_service.official_plan_id = v_plan_id THEN
    RETURN jsonb_build_object(
      'planId', v_plan.plan_id,
      'userId', v_plan.user_id,
      'planVersion', v_plan.plan_version,
      'status', v_plan.status,
      'calculationId', v_plan.calculation_id,
      'parentPlanId', v_plan.parent_plan_id,
      'plan', v_plan.plan,
      'changeReason', v_plan.change_reason,
      'createdAt', v_plan.created_at,
      'activatedAt', v_plan.activated_at,
      'pausedAt', v_plan.paused_at,
      'completedAt', v_plan.completed_at
    );
  END IF;

  IF v_plan.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '首个长期计划必须从draft状态交付';
  END IF;

  IF v_service.status IS DISTINCT FROM 'profile_confirmed' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '启动首个长期体验必须从profile_confirmed状态执行';
  END IF;

  IF p_trial_started_at < v_plan.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '体验开始时间不能早于计划创建时间';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app.user_plan_versions AS active_plan
    WHERE active_plan.user_id = v_user_id
      AND active_plan.status = 'active'
      AND active_plan.plan_id <> v_plan_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = '当前用户已有active计划，不能重复启动首个体验';
  END IF;

  UPDATE app.user_plan_versions
  SET status = 'active',
      activated_at = p_trial_started_at,
      paused_at = NULL,
      completed_at = NULL
  WHERE user_id = v_user_id
    AND plan_id = v_plan_id
    AND status = 'draft'
  RETURNING * INTO v_saved;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = '首个计划激活发生并发冲突';
  END IF;

  INSERT INTO app.plan_state_transitions (
    plan_id,
    user_id,
    from_status,
    to_status,
    reason,
    occurred_at
  ) VALUES (
    v_plan_id,
    v_user_id,
    'draft',
    'active',
    'official_plan_delivered',
    p_trial_started_at
  );

  UPDATE app.user_service_status
  SET status = 'trial_active',
      trial_started_at = p_trial_started_at,
      trial_ends_at = p_trial_ends_at,
      renewal_reminder_at = p_renewal_reminder_at,
      official_plan_id = v_plan_id,
      updated_at = p_trial_started_at
  WHERE user_id = v_user_id
    AND status = 'profile_confirmed';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = '体验状态启动发生并发冲突';
  END IF;

  INSERT INTO app.user_service_transitions (
    user_id,
    from_status,
    to_status,
    reason,
    occurred_at
  ) VALUES (
    v_user_id,
    'profile_confirmed',
    'trial_active',
    'first_official_plan_delivered',
    p_trial_started_at
  );

  RETURN jsonb_build_object(
    'planId', v_saved.plan_id,
    'userId', v_saved.user_id,
    'planVersion', v_saved.plan_version,
    'status', v_saved.status,
    'calculationId', v_saved.calculation_id,
    'parentPlanId', v_saved.parent_plan_id,
    'plan', v_saved.plan,
    'changeReason', v_saved.change_reason,
    'createdAt', v_saved.created_at,
    'activatedAt', v_saved.activated_at,
    'pausedAt', v_saved.paused_at,
    'completedAt', v_saved.completed_at
  );
END;
$function$;

ALTER FUNCTION app.activate_current_user_initial_plan_and_trial(
  varchar,
  timestamptz,
  timestamptz,
  timestamptz
) OWNER TO diet_owner;

REVOKE ALL ON FUNCTION app.activate_current_user_initial_plan_and_trial(
  varchar,
  timestamptz,
  timestamptz,
  timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.activate_current_user_initial_plan_and_trial(
  varchar,
  timestamptz,
  timestamptz,
  timestamptz
) TO diet_app, diet_owner;

COMMENT ON FUNCTION app.activate_current_user_initial_plan_and_trial(
  varchar,
  timestamptz,
  timestamptz,
  timestamptz
) IS
  '在同一事务中激活首个正式计划、启动14天体验并追加两类状态转换历史；同一计划可安全重试。';

COMMIT;

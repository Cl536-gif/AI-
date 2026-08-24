-- REVIEW ONLY: 004e 用户服务状态与转换历史。
-- 前置：001-004d 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE TABLE app.user_service_status (
  user_id varchar PRIMARY KEY
    REFERENCES app.users(user_id) ON DELETE CASCADE,
  status varchar(32) NOT NULL,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  renewal_reminder_at timestamptz,
  official_plan_id varchar(128),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_service_status_value_chk CHECK (
    status IN (
      'free',
      'onboarding_incomplete',
      'profile_confirmed',
      'trial_active',
      'trial_expired',
      'subscribed',
      'cancelled'
    )
  ),
  CONSTRAINT user_service_trial_order_chk CHECK (
    trial_started_at IS NULL
    OR trial_ends_at IS NULL
    OR trial_ends_at > trial_started_at
  ),
  CONSTRAINT user_service_reminder_order_chk CHECK (
    renewal_reminder_at IS NULL
    OR (
      trial_started_at IS NOT NULL
      AND trial_ends_at IS NOT NULL
      AND renewal_reminder_at >= trial_started_at
      AND renewal_reminder_at < trial_ends_at
    )
  ),
  CONSTRAINT user_service_active_trial_complete_chk CHECK (
    status <> 'trial_active'
    OR (
      trial_started_at IS NOT NULL
      AND trial_ends_at IS NOT NULL
      AND renewal_reminder_at IS NOT NULL
      AND official_plan_id IS NOT NULL
      AND btrim(official_plan_id) <> ''
    )
  )
);

CREATE TABLE app.user_service_transitions (
  transition_id varchar(128) PRIMARY KEY
    DEFAULT public.gen_random_uuid()::text,
  user_id varchar NOT NULL
    REFERENCES app.users(user_id) ON DELETE CASCADE,
  from_status varchar(32),
  to_status varchar(32) NOT NULL,
  reason varchar(512) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_service_transition_from_chk CHECK (
    from_status IS NULL OR from_status IN (
      'free',
      'onboarding_incomplete',
      'profile_confirmed',
      'trial_active',
      'trial_expired',
      'subscribed',
      'cancelled'
    )
  ),
  CONSTRAINT user_service_transition_to_chk CHECK (
    to_status IN (
      'free',
      'onboarding_incomplete',
      'profile_confirmed',
      'trial_active',
      'trial_expired',
      'subscribed',
      'cancelled'
    )
  ),
  CONSTRAINT user_service_transition_reason_chk CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 512
  )
);

CREATE INDEX user_service_transitions_user_time_idx
  ON app.user_service_transitions (user_id, occurred_at DESC, transition_id DESC);

ALTER TABLE app.user_service_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_service_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_service_status NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_service_transitions NO FORCE ROW LEVEL SECURITY;

CREATE POLICY user_service_status_select_own
ON app.user_service_status FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

CREATE POLICY user_service_transitions_select_own
ON app.user_service_transitions FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

REVOKE ALL ON TABLE app.user_service_status FROM PUBLIC, diet_app;
REVOKE ALL ON TABLE app.user_service_transitions FROM PUBLIC, diet_app;
GRANT SELECT ON TABLE app.user_service_status TO diet_app;
GRANT SELECT ON TABLE app.user_service_transitions TO diet_app;

CREATE OR REPLACE FUNCTION app.set_current_user_service_status(
  p_next jsonb,
  p_reason varchar DEFAULT 'unspecified'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_account_status varchar;
  v_status varchar;
  v_trial_started_at timestamptz;
  v_trial_ends_at timestamptz;
  v_renewal_reminder_at timestamptz;
  v_official_plan_id varchar;
  v_reason varchar := COALESCE(NULLIF(btrim(p_reason), ''), 'unspecified');
  v_previous_status varchar;
  v_now timestamptz := clock_timestamp();
  v_saved app.user_service_status%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF p_next IS NULL OR jsonb_typeof(p_next) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '服务状态参数格式不正确';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_next) AS next_key(key_name)
    WHERE key_name NOT IN (
      'status',
      'trialStartedAt',
      'trialEndsAt',
      'renewalReminderAt',
      'officialPlanId'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '服务状态包含未知字段';
  END IF;

  v_status := NULLIF(btrim(p_next->>'status'), '');
  IF v_status IS NULL OR v_status NOT IN (
    'free',
    'onboarding_incomplete',
    'profile_confirmed',
    'trial_active',
    'trial_expired',
    'subscribed',
    'cancelled'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '服务状态值不正确';
  END IF;

  IF char_length(v_reason) > 512 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '服务状态变更原因过长';
  END IF;

  BEGIN
    v_trial_started_at := NULLIF(p_next->>'trialStartedAt', '')::timestamptz;
    v_trial_ends_at := NULLIF(p_next->>'trialEndsAt', '')::timestamptz;
    v_renewal_reminder_at := NULLIF(p_next->>'renewalReminderAt', '')::timestamptz;
  EXCEPTION
    WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION USING ERRCODE = '22007', MESSAGE = '服务状态时间格式不正确';
  END;

  v_official_plan_id := NULLIF(btrim(p_next->>'officialPlanId'), '');
  IF char_length(v_official_plan_id) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '正式方案ID过长';
  END IF;

  IF v_trial_started_at IS NOT NULL
     AND v_trial_ends_at IS NOT NULL
     AND v_trial_ends_at <= v_trial_started_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '体验结束时间必须晚于开始时间';
  END IF;

  IF v_renewal_reminder_at IS NOT NULL
     AND (
       v_trial_started_at IS NULL
       OR v_trial_ends_at IS NULL
       OR v_renewal_reminder_at < v_trial_started_at
       OR v_renewal_reminder_at >= v_trial_ends_at
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '续费提醒时间必须位于体验周期内';
  END IF;

  IF v_status = 'trial_active'
     AND (
       v_trial_started_at IS NULL
       OR v_trial_ends_at IS NULL
       OR v_renewal_reminder_at IS NULL
       OR v_official_plan_id IS NULL
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '体验中状态缺少完整周期或正式方案';
  END IF;

  INSERT INTO app.users (user_id, status)
  VALUES (v_user_id, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT users.status
  INTO v_account_status
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  SELECT service.status
  INTO v_previous_status
  FROM app.user_service_status AS service
  WHERE service.user_id = v_user_id;

  INSERT INTO app.user_service_status (
    user_id,
    status,
    trial_started_at,
    trial_ends_at,
    renewal_reminder_at,
    official_plan_id,
    updated_at
  ) VALUES (
    v_user_id,
    v_status,
    v_trial_started_at,
    v_trial_ends_at,
    v_renewal_reminder_at,
    v_official_plan_id,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE SET
    status = EXCLUDED.status,
    trial_started_at = EXCLUDED.trial_started_at,
    trial_ends_at = EXCLUDED.trial_ends_at,
    renewal_reminder_at = EXCLUDED.renewal_reminder_at,
    official_plan_id = EXCLUDED.official_plan_id,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_saved;

  INSERT INTO app.user_service_transitions (
    user_id,
    from_status,
    to_status,
    reason,
    occurred_at
  ) VALUES (
    v_user_id,
    v_previous_status,
    v_status,
    v_reason,
    v_now
  );

  RETURN jsonb_build_object(
    'userId', v_saved.user_id,
    'status', v_saved.status,
    'trialStartedAt', v_saved.trial_started_at,
    'trialEndsAt', v_saved.trial_ends_at,
    'renewalReminderAt', v_saved.renewal_reminder_at,
    'officialPlanId', v_saved.official_plan_id,
    'updatedAt', v_saved.updated_at
  );
END;
$function$;

ALTER FUNCTION app.set_current_user_service_status(jsonb, varchar)
OWNER TO diet_owner;
REVOKE ALL ON FUNCTION app.set_current_user_service_status(jsonb, varchar)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_current_user_service_status(jsonb, varchar)
TO diet_app, diet_owner;

COMMENT ON TABLE app.user_service_status IS
  '当前用户长期服务生命周期状态；应用写入必须经过受控RPC。';
COMMENT ON TABLE app.user_service_transitions IS
  '用户服务状态转换追加历史。';
COMMENT ON FUNCTION app.set_current_user_service_status(jsonb, varchar) IS
  '原子替换当前用户服务状态并追加一条转换历史。';

COMMIT;

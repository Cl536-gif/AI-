-- REVIEW ONLY: 004g 方案生命周期核心（草稿、读取、通用状态转换）。
-- 首次方案与14天体验的跨表原子激活将在004h单独部署。
-- 前置：001-004f 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

ALTER TABLE app.energy_calculations
  ADD CONSTRAINT energy_calculations_user_calculation_unique
  UNIQUE (user_id, calculation_id);

CREATE TABLE app.user_plan_versions (
  plan_id varchar(128) PRIMARY KEY
    DEFAULT public.gen_random_uuid()::text,
  user_id varchar NOT NULL
    REFERENCES app.users(user_id) ON DELETE CASCADE,
  plan_version integer NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'draft',
  calculation_id varchar(128),
  parent_plan_id varchar(128),
  plan jsonb NOT NULL,
  change_reason varchar(4096) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT user_plan_versions_user_version_unique
    UNIQUE (user_id, plan_version),
  CONSTRAINT user_plan_versions_user_plan_unique
    UNIQUE (user_id, plan_id),
  CONSTRAINT user_plan_versions_calculation_fk
    FOREIGN KEY (user_id, calculation_id)
    REFERENCES app.energy_calculations(user_id, calculation_id),
  CONSTRAINT user_plan_versions_status_chk CHECK (
    status IN ('draft', 'active', 'paused', 'superseded', 'completed')
  ),
  CONSTRAINT user_plan_versions_version_chk CHECK (plan_version >= 1),
  CONSTRAINT user_plan_versions_plan_object_chk CHECK (jsonb_typeof(plan) = 'object'),
  CONSTRAINT user_plan_versions_change_reason_chk CHECK (
    char_length(btrim(change_reason)) BETWEEN 1 AND 4096
  ),
  CONSTRAINT user_plan_versions_timestamps_chk CHECK (
    (status = 'draft'
      AND activated_at IS NULL
      AND paused_at IS NULL
      AND completed_at IS NULL)
    OR (status = 'active'
      AND activated_at IS NOT NULL
      AND paused_at IS NULL
      AND completed_at IS NULL)
    OR (status = 'paused'
      AND activated_at IS NOT NULL
      AND paused_at IS NOT NULL
      AND completed_at IS NULL)
    OR (status IN ('superseded', 'completed')
      AND completed_at IS NOT NULL)
  )
);

ALTER TABLE app.user_plan_versions
  ADD CONSTRAINT user_plan_versions_parent_fk
  FOREIGN KEY (user_id, parent_plan_id)
  REFERENCES app.user_plan_versions(user_id, plan_id);

CREATE UNIQUE INDEX user_plan_versions_one_active_per_user_idx
  ON app.user_plan_versions (user_id)
  WHERE status = 'active';

CREATE INDEX user_plan_versions_user_version_idx
  ON app.user_plan_versions (user_id, plan_version DESC);

CREATE TABLE app.plan_state_transitions (
  transition_id varchar(128) PRIMARY KEY
    DEFAULT public.gen_random_uuid()::text,
  plan_id varchar(128) NOT NULL,
  user_id varchar NOT NULL,
  from_status varchar(32),
  to_status varchar(32) NOT NULL,
  reason varchar(4096) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT plan_state_transitions_plan_fk
    FOREIGN KEY (user_id, plan_id)
    REFERENCES app.user_plan_versions(user_id, plan_id) ON DELETE CASCADE,
  CONSTRAINT plan_state_transitions_from_status_chk CHECK (
    from_status IS NULL
    OR from_status IN ('draft', 'active', 'paused', 'superseded', 'completed')
  ),
  CONSTRAINT plan_state_transitions_to_status_chk CHECK (
    to_status IN ('draft', 'active', 'paused', 'superseded', 'completed')
  ),
  CONSTRAINT plan_state_transitions_reason_chk CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 4096
  )
);

CREATE INDEX plan_state_transitions_plan_time_idx
  ON app.plan_state_transitions (
    user_id,
    plan_id,
    occurred_at DESC,
    transition_id DESC
  );

ALTER TABLE app.user_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.plan_state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_plan_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.plan_state_transitions NO FORCE ROW LEVEL SECURITY;

CREATE POLICY user_plan_versions_select_own
ON app.user_plan_versions FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

CREATE POLICY plan_state_transitions_select_own
ON app.plan_state_transitions FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

REVOKE ALL ON TABLE app.user_plan_versions FROM PUBLIC, diet_app;
REVOKE ALL ON TABLE app.plan_state_transitions FROM PUBLIC, diet_app;
GRANT SELECT ON TABLE app.user_plan_versions TO diet_app;
GRANT SELECT ON TABLE app.plan_state_transitions TO diet_app;

CREATE OR REPLACE FUNCTION app.create_current_user_plan_draft(
  p_input jsonb,
  p_created_at timestamptz DEFAULT clock_timestamp()
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
  v_calculation_id varchar;
  v_parent_plan_id varchar;
  v_plan jsonb;
  v_change_reason varchar;
  v_created_at timestamptz := COALESCE(p_created_at, clock_timestamp());
  v_next_version integer;
  v_saved app.user_plan_versions%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划草稿参数格式不正确';
  END IF;

  IF octet_length(p_input::text) > 524288 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划草稿过大';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_input) AS next_key(key_name)
    WHERE key_name NOT IN ('calculationId', 'parentPlanId', 'plan', 'changeReason')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划草稿包含未知字段';
  END IF;

  v_calculation_id := NULLIF(btrim(p_input->>'calculationId'), '');
  v_parent_plan_id := NULLIF(btrim(p_input->>'parentPlanId'), '');
  v_plan := p_input->'plan';
  v_change_reason := NULLIF(btrim(p_input->>'changeReason'), '');

  IF jsonb_typeof(v_plan) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_input->'changeReason') IS DISTINCT FROM 'string'
     OR v_change_reason IS NULL
     OR char_length(v_change_reason) > 4096
     OR char_length(v_calculation_id) > 128
     OR char_length(v_parent_plan_id) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划草稿字段不正确';
  END IF;

  IF p_input ? 'calculationId'
     AND jsonb_typeof(p_input->'calculationId') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划计算记录ID格式不正确';
  END IF;

  IF p_input ? 'parentPlanId'
     AND jsonb_typeof(p_input->'parentPlanId') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '上一版本计划ID格式不正确';
  END IF;

  IF v_plan ? 'energyCalculationId'
     AND NULLIF(btrim(v_plan->>'energyCalculationId'), '')
       IS DISTINCT FROM v_calculation_id THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划内外能量计算记录ID不一致';
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

  IF v_calculation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.energy_calculations AS calculation
    WHERE calculation.user_id = v_user_id
      AND calculation.calculation_id = v_calculation_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = '计划引用的计算记录不存在或不属于当前用户';
  END IF;

  IF v_parent_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.user_plan_versions AS parent_plan
    WHERE parent_plan.user_id = v_user_id
      AND parent_plan.plan_id = v_parent_plan_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = '上一版本计划不存在或不属于当前用户';
  END IF;

  SELECT COALESCE(MAX(plan_version), 0) + 1
  INTO v_next_version
  FROM app.user_plan_versions
  WHERE user_id = v_user_id;

  INSERT INTO app.user_plan_versions (
    user_id,
    plan_version,
    status,
    calculation_id,
    parent_plan_id,
    plan,
    change_reason,
    created_at
  ) VALUES (
    v_user_id,
    v_next_version,
    'draft',
    v_calculation_id,
    v_parent_plan_id,
    v_plan,
    v_change_reason,
    v_created_at
  )
  RETURNING * INTO v_saved;

  INSERT INTO app.plan_state_transitions (
    plan_id,
    user_id,
    from_status,
    to_status,
    reason,
    occurred_at
  ) VALUES (
    v_saved.plan_id,
    v_user_id,
    NULL,
    'draft',
    'plan_draft_created',
    v_created_at
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

CREATE OR REPLACE FUNCTION app.transition_current_user_plan(
  p_plan_id varchar,
  p_to_status varchar,
  p_reason varchar DEFAULT 'unspecified',
  p_occurred_at timestamptz DEFAULT clock_timestamp()
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
  v_plan_id varchar := NULLIF(btrim(p_plan_id), '');
  v_to_status varchar := NULLIF(btrim(p_to_status), '');
  v_reason varchar := COALESCE(NULLIF(btrim(p_reason), ''), 'unspecified');
  v_occurred_at timestamptz := COALESCE(p_occurred_at, clock_timestamp());
  v_current app.user_plan_versions%ROWTYPE;
  v_existing_active app.user_plan_versions%ROWTYPE;
  v_parent app.user_plan_versions%ROWTYPE;
  v_service_status varchar;
  v_saved app.user_plan_versions%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF v_plan_id IS NULL OR char_length(v_plan_id) > 128
     OR v_to_status IS NULL
     OR v_to_status NOT IN ('active', 'paused', 'superseded', 'completed')
     OR char_length(v_reason) > 4096 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划状态转换参数不正确';
  END IF;

  SELECT users.status
  INTO v_account_status
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  SELECT * INTO v_current
  FROM app.user_plan_versions
  WHERE user_id = v_user_id AND plan_id = v_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '计划不存在或不属于当前用户';
  END IF;

  IF v_occurred_at < GREATEST(
    v_current.created_at,
    v_current.activated_at,
    v_current.paused_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划状态转换时间早于已有计划时间';
  END IF;

  IF NOT (
    (v_current.status = 'draft' AND v_to_status = 'active')
    OR (v_current.status = 'active'
      AND v_to_status IN ('paused', 'superseded', 'completed'))
    OR (v_current.status = 'paused'
      AND v_to_status IN ('active', 'superseded', 'completed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划状态转换不允许';
  END IF;

  IF v_to_status = 'active' THEN
    SELECT status INTO v_service_status
    FROM app.user_service_status
    WHERE user_id = v_user_id;

    IF v_service_status IS NULL
       OR v_service_status NOT IN ('trial_active', 'subscribed') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前服务状态不能启用长期计划';
    END IF;

    SELECT * INTO v_existing_active
    FROM app.user_plan_versions
    WHERE user_id = v_user_id
      AND status = 'active'
      AND plan_id <> v_plan_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_occurred_at < v_existing_active.created_at THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '替换时间早于现有active计划创建时间';
      END IF;

      UPDATE app.user_plan_versions
      SET status = 'superseded', completed_at = v_occurred_at
      WHERE user_id = v_user_id AND plan_id = v_existing_active.plan_id;

      INSERT INTO app.plan_state_transitions (
        plan_id, user_id, from_status, to_status, reason, occurred_at
      ) VALUES (
        v_existing_active.plan_id,
        v_user_id,
        'active',
        'superseded',
        'replaced_by:' || v_plan_id,
        v_occurred_at
      );
    END IF;

    IF v_current.parent_plan_id IS NOT NULL THEN
      SELECT * INTO v_parent
      FROM app.user_plan_versions
      WHERE user_id = v_user_id
        AND plan_id = v_current.parent_plan_id
      FOR UPDATE;

      IF FOUND
         AND v_parent.status = 'paused'
         AND v_parent.plan_id IS DISTINCT FROM v_existing_active.plan_id THEN
        IF v_occurred_at < GREATEST(
          v_parent.created_at,
          v_parent.activated_at,
          v_parent.paused_at
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '替换时间早于父计划已有时间';
        END IF;

        UPDATE app.user_plan_versions
        SET status = 'superseded', completed_at = v_occurred_at
        WHERE user_id = v_user_id
          AND plan_id = v_parent.plan_id
          AND status = 'paused';

        IF FOUND THEN
          INSERT INTO app.plan_state_transitions (
            plan_id, user_id, from_status, to_status, reason, occurred_at
          ) VALUES (
            v_parent.plan_id,
            v_user_id,
            'paused',
            'superseded',
            'replaced_by:' || v_plan_id,
            v_occurred_at
          );
        END IF;
      END IF;
    END IF;
  END IF;

  UPDATE app.user_plan_versions
  SET status = v_to_status,
      activated_at = CASE
        WHEN v_to_status = 'active' THEN COALESCE(activated_at, v_occurred_at)
        ELSE activated_at
      END,
      paused_at = CASE
        WHEN v_to_status = 'paused' THEN v_occurred_at
        WHEN v_to_status = 'active' THEN NULL
        ELSE paused_at
      END,
      completed_at = CASE
        WHEN v_to_status IN ('superseded', 'completed') THEN v_occurred_at
        ELSE completed_at
      END
  WHERE user_id = v_user_id AND plan_id = v_plan_id
  RETURNING * INTO v_saved;

  INSERT INTO app.plan_state_transitions (
    plan_id, user_id, from_status, to_status, reason, occurred_at
  ) VALUES (
    v_plan_id,
    v_user_id,
    v_current.status,
    v_to_status,
    v_reason,
    v_occurred_at
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

ALTER FUNCTION app.create_current_user_plan_draft(jsonb, timestamptz)
OWNER TO diet_owner;
ALTER FUNCTION app.transition_current_user_plan(varchar, varchar, varchar, timestamptz)
OWNER TO diet_owner;

REVOKE ALL ON FUNCTION app.create_current_user_plan_draft(jsonb, timestamptz)
FROM PUBLIC;
REVOKE ALL ON FUNCTION app.transition_current_user_plan(varchar, varchar, varchar, timestamptz)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.create_current_user_plan_draft(jsonb, timestamptz)
TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.transition_current_user_plan(varchar, varchar, varchar, timestamptz)
TO diet_app, diet_owner;

COMMENT ON TABLE app.user_plan_versions IS
  '不可覆盖的阶段计划版本；同一用户最多一个active计划。';
COMMENT ON TABLE app.plan_state_transitions IS
  '阶段计划状态转换追加历史。';
COMMENT ON FUNCTION app.create_current_user_plan_draft(jsonb, timestamptz) IS
  '在用户行锁下分配递增版本号并原子创建草稿及初始转换历史。';
COMMENT ON FUNCTION app.transition_current_user_plan(varchar, varchar, varchar, timestamptz) IS
  '校验状态机并原子转换计划；激活新版时替换既有active或paused父计划。';

COMMIT;

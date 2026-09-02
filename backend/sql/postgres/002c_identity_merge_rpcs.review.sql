-- REVIEW ONLY: 002 身份合并批次的受控 RPC。
-- 前置：002a 和 002b 已成功提交。
-- 所有跨用户逻辑必须在数据库单事务中完成。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.merge_value_is_blank(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT
    p_value IS NULL
    OR p_value = 'null'::jsonb
    OR (
      jsonb_typeof(p_value) = 'string'
      AND btrim(p_value #>> '{}') IN ('', 'unknown')
    )
    OR (
      jsonb_typeof(p_value) = 'array'
      AND jsonb_array_length(p_value) = 0
    );
$function$;

-- 在秘书向用户主动展示待复核字段时生成一次性请求。
-- 本 RPC 记录结构化展示事实，不保存对话原文。
CREATE OR REPLACE FUNCTION app.begin_current_long_term_profile_confirmation(
  p_onboarding_session_id varchar,
  p_prompt_turn_id varchar,
  p_presented_fields jsonb,
  p_prompted_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_request_id uuid;
  v_existing app.long_term_profile_confirmation_requests%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.users AS u
    WHERE u.user_id = v_user_id AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '当前用户不是active状态';
  END IF;

  IF p_onboarding_session_id IS NULL
     OR p_onboarding_session_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'onboardingSessionId不合法';
  END IF;

  IF p_prompt_turn_id IS NULL
     OR p_prompt_turn_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'promptTurnId不合法';
  END IF;

  IF p_prompted_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'promptedAt不能为空';
  END IF;

  IF p_presented_fields IS NULL OR jsonb_typeof(p_presented_fields) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'presentedFields必须是非空对象';
  END IF;

  IF p_presented_fields = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'presentedFields必须是非空对象';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_each(p_presented_fields) AS fields(field_path, field_value)
    WHERE fields.field_path NOT IN (
      'body.equationSex', 'body.ageYears', 'body.heightCm',
      'body.currentWeightKg', 'body.targetWeightKg',
      'body.dailyActivity', 'body.recentWeightChange',
      'diet.scene', 'diet.cafeteriaMode', 'diet.budgetCnyPerMeal',
      'diet.tastePreferences', 'diet.restrictions', 'diet.goals',
      'diet.exerciseBaseline'
    )
      OR fields.field_value = 'null'::jsonb
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'presentedFields包含非法路径或空值';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      jsonb_build_array('long_term_profile_confirmation', v_user_id, p_onboarding_session_id)::text,
      0
    )
  );

  -- prompt_turn_id 也是用户级幂等键；不同会话复用同一轮次也必须串行判断。
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      jsonb_build_array('long_term_profile_confirmation_prompt', v_user_id, p_prompt_turn_id)::text,
      0
    )
  );

  -- 必须在所有串行锁之后取数据库时间，避免等待期间形成倒置时间线。
  v_now := clock_timestamp();

  SELECT request.*
  INTO v_existing
  FROM app.long_term_profile_confirmation_requests AS request
  WHERE request.user_id = v_user_id
    AND request.prompt_turn_id = p_prompt_turn_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.onboarding_session_id IS DISTINCT FROM p_onboarding_session_id
       OR v_existing.presented_fields IS DISTINCT FROM p_presented_fields
       OR v_existing.prompted_at IS DISTINCT FROM p_prompted_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = '同一promptTurnId对应的会话、展示字段或提问时间不一致';
    END IF;

    RETURN jsonb_build_object(
      'requestId', v_existing.request_id,
      'onboardingSessionId', v_existing.onboarding_session_id,
      'promptTurnId', v_existing.prompt_turn_id,
      'presentedFields', v_existing.presented_fields,
      'status', v_existing.status,
      'promptedAt', v_existing.prompted_at,
      'responseTurnId', v_existing.response_turn_id,
      'respondedAt', v_existing.responded_at,
      'resolvedAt', v_existing.resolved_at,
      'idempotentReplay', true
    );
  END IF;

  -- 同一用户、同一建档会话只保留一个待确认请求。
  UPDATE app.long_term_profile_confirmation_requests
  SET status = 'cancelled',
      resolved_at = v_now
  WHERE user_id = v_user_id
    AND onboarding_session_id = p_onboarding_session_id
    AND status = 'pending';

  INSERT INTO app.long_term_profile_confirmation_requests (
    user_id,
    onboarding_session_id,
    prompt_turn_id,
    presented_fields,
    prompted_at,
    status,
    created_at
  )
  VALUES (
    v_user_id,
    p_onboarding_session_id,
    p_prompt_turn_id,
    p_presented_fields,
    p_prompted_at,
    'pending',
    v_now
  )
  RETURNING request_id INTO v_request_id;

  RETURN jsonb_build_object(
    'requestId', v_request_id,
    'onboardingSessionId', p_onboarding_session_id,
    'promptTurnId', p_prompt_turn_id,
    'presentedFields', p_presented_fields,
    'status', 'pending',
    'promptedAt', p_prompted_at,
    'idempotentReplay', false
  );
END;
$function$;

-- 只有秘书在长期建档中主动摆出字段、且用户正面确认后，
-- 受信后端才能调用本边界。后台静默复用旧值不得调用。
CREATE OR REPLACE FUNCTION app.save_current_long_term_profile_fields(
  p_profile jsonb,
  p_confirmed_fields jsonb,
  p_confirmation_request_id uuid,
  p_response_turn_id varchar,
  p_responded_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_request app.long_term_profile_confirmation_requests%ROWTYPE;
  v_before_snapshot jsonb;
  v_snapshot jsonb;
  v_revision_id uuid;
  v_field_path text;
  v_confirmed_value jsonb;
  v_presented_value jsonb;
  v_field record;
  v_save_started_at timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.users AS u
    WHERE u.user_id = v_user_id AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '当前用户不是active状态';
  END IF;

  IF p_confirmation_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'confirmationRequestId不能为空';
  END IF;

  IF p_response_turn_id IS NULL
     OR p_response_turn_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'responseTurnId不合法';
  END IF;

  IF p_responded_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'respondedAt不能为空';
  END IF;

  SELECT request.*
  INTO v_request
  FROM app.long_term_profile_confirmation_requests AS request
  WHERE request.request_id = p_confirmation_request_id
    AND request.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '确认请求不存在或不属于当前用户';
  END IF;

  IF p_response_turn_id = v_request.prompt_turn_id
     OR p_responded_at < v_request.prompted_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = '用户回应轮次必须晚于秘书提问轮次';
  END IF;

  IF p_confirmed_fields IS NULL
     OR jsonb_typeof(p_confirmed_fields) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'confirmedFields必须是非空字段路径数组';
  END IF;

  IF jsonb_array_length(p_confirmed_fields) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'confirmedFields必须是非空字段路径数组';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_confirmed_fields) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'string'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'confirmedFields只能包含字符串';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_confirmed_fields) AS fields(value)
    WHERE NOT (v_request.presented_fields ? fields.value)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmedFields必须是本次秘书已展示字段的子集';
  END IF;

  IF (
    SELECT COUNT(*) FROM jsonb_array_elements_text(p_confirmed_fields)
  ) <> (
    SELECT COUNT(DISTINCT value)
    FROM jsonb_array_elements_text(p_confirmed_fields) AS fields(value)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'confirmedFields不能重复';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_confirmed_fields) AS fields(value)
    WHERE fields.value NOT IN (
      'body.equationSex', 'body.ageYears', 'body.heightCm',
      'body.currentWeightKg', 'body.targetWeightKg',
      'body.dailyActivity', 'body.recentWeightChange',
      'diet.scene', 'diet.cafeteriaMode', 'diet.budgetCnyPerMeal',
      'diet.tastePreferences', 'diet.restrictions', 'diet.goals',
      'diet.exerciseBaseline'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'confirmedFields包含非法字段路径';
  END IF;

  IF v_request.status = 'cancelled' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '确认请求已取消，不能再消费';
  END IF;

  IF v_request.status = 'consumed' THEN
    IF v_request.response_turn_id IS DISTINCT FROM p_response_turn_id
       OR v_request.responded_at IS DISTINCT FROM p_responded_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = '已消费请求对应的回应轮次或回应时间不一致';
    END IF;

    SELECT pr.profile_snapshot, pr.revision_id
    INTO v_snapshot, v_revision_id
    FROM app.long_term_profile_field_confirmations AS confirmation
    JOIN app.profile_revisions AS pr
      ON pr.user_id = confirmation.user_id
     AND pr.revision_id = confirmation.profile_revision_id
    WHERE confirmation.user_id = v_user_id
      AND confirmation.confirmation_request_id = v_request.request_id
    ORDER BY confirmation.created_at, confirmation.confirmation_id
    LIMIT 1;

    IF v_revision_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = '已消费确认请求缺少字段确认事实';
    END IF;

    IF p_profile IS DISTINCT FROM v_snapshot THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = '已消费请求对应的档案内容与本次重试不一致';
    END IF;

    IF (
      SELECT COUNT(*)
      FROM app.long_term_profile_field_confirmations AS confirmation
      WHERE confirmation.user_id = v_user_id
        AND confirmation.confirmation_request_id = v_request.request_id
    ) <> jsonb_array_length(p_confirmed_fields)
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(p_confirmed_fields) AS fields(value)
         WHERE NOT EXISTS (
           SELECT 1
           FROM app.long_term_profile_field_confirmations AS confirmation
           WHERE confirmation.user_id = v_user_id
             AND confirmation.confirmation_request_id = v_request.request_id
             AND confirmation.field_path = fields.value
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = '已消费请求对应的确认字段与本次重试不一致';
    END IF;

    RETURN jsonb_build_object(
      'profile', v_snapshot,
      'profileRevisionId', v_revision_id,
      'confirmationRequestId', v_request.request_id,
      'confirmedFields', p_confirmed_fields,
      'onboardingSessionId', v_request.onboarding_session_id,
      'promptTurnId', v_request.prompt_turn_id,
      'responseTurnId', v_request.response_turn_id,
      'confirmedAt', v_request.responded_at,
      'idempotentReplay', true
    );
  END IF;

  -- 对已有档案行加锁后再比较，防止并发普通档案写入使本轮基线过期。
  PERFORM 1
  FROM app.user_profiles AS profile
  WHERE profile.user_id = v_user_id
  FOR UPDATE;

  v_before_snapshot := COALESCE(
    app.profile_snapshot_for_merge(v_user_id),
    '{
      "schemaVersion": 1,
      "body": {
        "equationSex": null,
        "ageYears": null,
        "heightCm": null,
        "currentWeightKg": null,
        "targetWeightKg": null,
        "dailyActivity": null,
        "recentWeightChange": null
      },
      "diet": {
        "scene": "unknown",
        "cafeteriaMode": "unknown",
        "budgetCnyPerMeal": null,
        "tastePreferences": [],
        "restrictions": [],
        "goals": [],
        "exerciseBaseline": null
      }
    }'::jsonb
  );

  -- 专用长期建档入口不得夹带本轮未确认的档案改动。
  FOR v_field IN
    SELECT *
    FROM (VALUES
      ('body.equationSex', ARRAY['body', 'equationSex']::text[]),
      ('body.ageYears', ARRAY['body', 'ageYears']::text[]),
      ('body.heightCm', ARRAY['body', 'heightCm']::text[]),
      ('body.currentWeightKg', ARRAY['body', 'currentWeightKg']::text[]),
      ('body.targetWeightKg', ARRAY['body', 'targetWeightKg']::text[]),
      ('body.dailyActivity', ARRAY['body', 'dailyActivity']::text[]),
      ('body.recentWeightChange', ARRAY['body', 'recentWeightChange']::text[]),
      ('diet.scene', ARRAY['diet', 'scene']::text[]),
      ('diet.cafeteriaMode', ARRAY['diet', 'cafeteriaMode']::text[]),
      ('diet.budgetCnyPerMeal', ARRAY['diet', 'budgetCnyPerMeal']::text[]),
      ('diet.tastePreferences', ARRAY['diet', 'tastePreferences']::text[]),
      ('diet.restrictions', ARRAY['diet', 'restrictions']::text[]),
      ('diet.goals', ARRAY['diet', 'goals']::text[]),
      ('diet.exerciseBaseline', ARRAY['diet', 'exerciseBaseline']::text[])
    ) AS fields(field_path, json_path)
  LOOP
    IF (v_before_snapshot #> v_field.json_path)
         IS DISTINCT FROM (p_profile #> v_field.json_path)
       AND NOT (p_confirmed_fields ? v_field.field_path) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = format('字段%s本轮未确认，不得通过长期建档入口修改', v_field.field_path);
    END IF;
  END LOOP;

  -- 现有 RPC 会锁定并更新当前用户档案，同事务追加修订。
  v_save_started_at := clock_timestamp();
  v_snapshot := app.save_current_user_profile(p_profile, 'secretary');

  SELECT pr.revision_id
  INTO v_revision_id
  FROM app.profile_revisions AS pr
  WHERE pr.user_id = v_user_id
    AND pr.recorded_at >= v_save_started_at
    AND pr.source = 'secretary'
    AND pr.profile_snapshot = v_snapshot
  ORDER BY pr.recorded_at DESC, pr.revision_id DESC
  LIMIT 1;

  IF v_revision_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '长期建档档案修订未生成';
  END IF;

  UPDATE app.long_term_profile_confirmation_requests
  SET status = 'consumed',
      response_turn_id = p_response_turn_id,
      responded_at = p_responded_at,
      resolved_at = clock_timestamp()
  WHERE request_id = v_request.request_id
    AND user_id = v_user_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '确认请求已被其他调用消费';
  END IF;

  FOR v_field_path IN
    SELECT value
    FROM jsonb_array_elements_text(p_confirmed_fields) AS fields(value)
  LOOP
    v_confirmed_value := v_snapshot #> string_to_array(v_field_path, '.');
    IF v_confirmed_value IS NULL OR v_confirmed_value = 'null'::jsonb THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = format('确认字段%s没有可保存的值', v_field_path);
    END IF;

    v_presented_value := v_request.presented_fields -> v_field_path;
    IF v_presented_value IS DISTINCT FROM v_confirmed_value THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('确认字段%s的保存值与秘书展示值不一致', v_field_path);
    END IF;

    INSERT INTO app.long_term_profile_field_confirmations (
      user_id,
      field_path,
      confirmed_value,
      profile_revision_id,
      confirmation_request_id,
      onboarding_session_id,
      confirmed_at
    )
    VALUES (
      v_user_id,
      v_field_path,
      v_confirmed_value,
      v_revision_id,
      v_request.request_id,
      v_request.onboarding_session_id,
      p_responded_at
    );
  END LOOP;

  RETURN jsonb_build_object(
    'profile', v_snapshot,
    'profileRevisionId', v_revision_id,
    'confirmationRequestId', v_request.request_id,
    'confirmedFields', p_confirmed_fields,
    'onboardingSessionId', v_request.onboarding_session_id,
    'promptTurnId', v_request.prompt_turn_id,
    'responseTurnId', p_response_turn_id,
    'confirmedAt', p_responded_at,
    'idempotentReplay', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.profile_snapshot_for_merge(p_user_id varchar)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT jsonb_build_object(
    'schemaVersion', up.schema_version,
    'body', jsonb_build_object(
      'equationSex', up.equation_sex,
      'ageYears', up.age_years,
      'heightCm', up.height_cm,
      'currentWeightKg', up.current_weight_kg,
      'targetWeightKg', up.target_weight_kg,
      'dailyActivity', up.daily_activity,
      'recentWeightChange', up.recent_weight_change
    ),
    'diet', jsonb_build_object(
      'scene', up.scene,
      'cafeteriaMode', up.cafeteria_mode,
      'budgetCnyPerMeal', up.budget_cny_per_meal,
      'tastePreferences', up.taste_preferences,
      'restrictions', up.restrictions,
      'goals', up.goals,
      'exerciseBaseline', up.exercise_baseline
    )
  )
  FROM app.user_profiles AS up
  WHERE up.user_id = p_user_id;
$function$;

CREATE OR REPLACE FUNCTION app.user_event_merge_fingerprint(
  p_event_type varchar,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_normalized_supersedes_event_id varchar DEFAULT NULL
)
RETURNS char(64)
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT encode(
    public.digest(
      convert_to(
        jsonb_build_object(
          'eventType', p_event_type,
          'occurredAtUtc', to_char(
            p_occurred_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'payload', p_payload,
          'supersedesEventId', CASE
            WHEN p_event_type = 'user_correction'
              THEN p_normalized_supersedes_event_id
            ELSE NULL
          END
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )::char(64);
$function$;

-- 后端先对原始 device ID 计算 SHA-256，数据库只接受摘要。
CREATE OR REPLACE FUNCTION app.resolve_anonymous_identity(
  p_identity_type varchar,
  p_external_subject_hash varchar
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_identity_type varchar := lower(btrim(p_identity_type));
  v_hash varchar := lower(btrim(p_external_subject_hash));
  v_user_id varchar;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_identity_type IS NULL OR v_identity_type <> 'device_sha256' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'identityType不在允许范围内';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'externalSubjectHash必须是64位SHA-256十六进制摘要';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      jsonb_build_array(v_identity_type, v_hash)::text,
      0
    )
  );

  SELECT ui.user_id
  INTO v_user_id
  FROM app.user_identities AS ui
  WHERE ui.identity_type = v_identity_type
    AND ui.external_subject_hash = v_hash
  FOR UPDATE;

  IF FOUND THEN
    UPDATE app.user_identities
    SET last_seen_at = GREATEST(last_seen_at, v_now)
    WHERE identity_type = v_identity_type
      AND external_subject_hash = v_hash;

    RETURN jsonb_build_object(
      'userId', v_user_id,
      'identityType', v_identity_type,
      'existing', true
    );
  END IF;

  v_user_id := 'anon:' || replace(public.gen_random_uuid()::text, '-', '');

  INSERT INTO app.users (user_id, status)
  VALUES (v_user_id, 'active');

  INSERT INTO app.user_identities (
    identity_type,
    external_subject_hash,
    user_id,
    created_at,
    last_seen_at
  )
  VALUES (
    v_identity_type,
    v_hash,
    v_user_id,
    v_now,
    v_now
  );

  RETURN jsonb_build_object(
    'userId', v_user_id,
    'identityType', v_identity_type,
    'existing', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.merge_current_account_from_anonymous(
  p_source_user_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_source_user_id varchar := btrim(p_source_user_id);
  v_target_user_id varchar := app.current_user_id();
  v_source_status varchar;
  v_target_status varchar;
  v_existing app.user_merges%ROWTYPE;
  v_merge_id uuid := public.gen_random_uuid();
  v_merged_at timestamptz;
  v_account_profile jsonb;
  v_merged_profile jsonb;
  v_account_value jsonb;
  v_guest_value jsonb;
  v_field record;
  v_profile_changed boolean := false;
  v_account_updated_at timestamptz;
  v_guest_updated_at timestamptz;
  v_event record;
  v_duplicate_event_id varchar;
  v_duplicate_event_type varchar;
  v_duplicate_supersedes_event_id varchar;
  v_duplicate_event_hash char(64);
  v_target_event_id varchar;
  v_target_supersedes_event_id varchar;
  v_target_supersedes_status varchar;
  v_event_hash char(64);
  v_action varchar;
  v_progress integer;
  v_remaining integer;
BEGIN
  IF v_target_user_id IS NULL OR v_target_user_id NOT LIKE 'acct:%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '28000',
      MESSAGE = '合并目标必须来自已认证的acct账号上下文';
  END IF;

  IF v_source_user_id IS NULL OR v_source_user_id NOT LIKE 'anon:%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = '只能合并anon游客身份';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      jsonb_build_array('identity_merge', v_source_user_id)::text,
      0
    )
  );

  SELECT um.*
  INTO v_existing
  FROM app.user_merges AS um
  WHERE um.source_user_id = v_source_user_id;

  IF FOUND THEN
    IF v_existing.target_user_id <> v_target_user_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = '该游客身份已合并到其他账号';
    END IF;

    RETURN jsonb_build_object(
      'mergeId', v_existing.merge_id,
      'sourceUserId', v_existing.source_user_id,
      'targetUserId', v_existing.target_user_id,
      'status', v_existing.status,
      'mergedAt', v_existing.merged_at,
      'idempotentReplay', true,
      'profileConflictCount', (
        SELECT COUNT(*)
        FROM app.profile_merge_conflicts
        WHERE merge_id = v_existing.merge_id
      ),
      'migratedEventCount', (
        SELECT COUNT(*)
        FROM app.event_merge_audit
        WHERE merge_id = v_existing.merge_id
          AND action IN ('migrated', 'migrated_restricted')
      ),
      'deduplicatedEventCount', (
        SELECT COUNT(*)
        FROM app.event_merge_audit
        WHERE merge_id = v_existing.merge_id
          AND action = 'deduplicated'
      )
    );
  END IF;

  INSERT INTO app.users (user_id, status)
  VALUES (v_target_user_id, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT u.status
  INTO v_source_status
  FROM app.users AS u
  WHERE u.user_id = v_source_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_source_status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '游客身份不存在或不是active状态';
  END IF;

  SELECT u.status
  INTO v_target_status
  FROM app.users AS u
  WHERE u.user_id = v_target_user_id
  FOR UPDATE;

  IF v_target_status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '目标账号不是active状态';
  END IF;

  -- 用户行是跨业务表的总闸门；已有档案行再按固定顺序显式锁定，
  -- 使账号快照、游客确认事实与后续写入处在同一稳定边界内。
  PERFORM 1
  FROM app.user_profiles AS profile
  WHERE profile.user_id IN (v_source_user_id, v_target_user_id)
  ORDER BY profile.user_id
  FOR UPDATE;

  -- users 行锁构成合并边界；锁前完成的写入属于合并前，锁后写入会等待。
  v_merged_at := clock_timestamp();

  INSERT INTO app.user_merges (
    merge_id,
    source_user_id,
    target_user_id,
    status,
    merged_at
  )
  VALUES (
    v_merge_id,
    v_source_user_id,
    v_target_user_id,
    'completed',
    v_merged_at
  );

  SELECT up.updated_at INTO v_account_updated_at
  FROM app.user_profiles AS up
  WHERE up.user_id = v_target_user_id;

  v_account_profile := COALESCE(
    app.profile_snapshot_for_merge(v_target_user_id),
    '{
      "schemaVersion": 1,
      "body": {
        "equationSex": null,
        "ageYears": null,
        "heightCm": null,
        "currentWeightKg": null,
        "targetWeightKg": null,
        "dailyActivity": null,
        "recentWeightChange": null
      },
      "diet": {
        "scene": "unknown",
        "cafeteriaMode": "unknown",
        "budgetCnyPerMeal": null,
        "tastePreferences": [],
        "restrictions": [],
        "goals": [],
        "exerciseBaseline": null
      }
    }'::jsonb
  );

  v_merged_profile := v_account_profile;

  FOR v_field IN
    SELECT *
    FROM (VALUES
      ('body.equationSex', ARRAY['body', 'equationSex']::text[]),
      ('body.ageYears', ARRAY['body', 'ageYears']::text[]),
      ('body.heightCm', ARRAY['body', 'heightCm']::text[]),
      ('body.currentWeightKg', ARRAY['body', 'currentWeightKg']::text[]),
      ('body.targetWeightKg', ARRAY['body', 'targetWeightKg']::text[]),
      ('body.dailyActivity', ARRAY['body', 'dailyActivity']::text[]),
      ('body.recentWeightChange', ARRAY['body', 'recentWeightChange']::text[]),
      ('diet.scene', ARRAY['diet', 'scene']::text[]),
      ('diet.cafeteriaMode', ARRAY['diet', 'cafeteriaMode']::text[]),
      ('diet.budgetCnyPerMeal', ARRAY['diet', 'budgetCnyPerMeal']::text[]),
      ('diet.tastePreferences', ARRAY['diet', 'tastePreferences']::text[]),
      ('diet.restrictions', ARRAY['diet', 'restrictions']::text[]),
      ('diet.goals', ARRAY['diet', 'goals']::text[]),
      ('diet.exerciseBaseline', ARRAY['diet', 'exerciseBaseline']::text[])
    ) AS fields(field_path, json_path)
  LOOP
    v_account_value := v_account_profile #> v_field.json_path;
    v_guest_value := NULL;
    v_guest_updated_at := NULL;

    SELECT confirmation.confirmed_value, confirmation.created_at
    INTO v_guest_value, v_guest_updated_at
    FROM app.long_term_profile_field_confirmations AS confirmation
    WHERE confirmation.user_id = v_source_user_id
      AND confirmation.field_path = v_field.field_path
    ORDER BY confirmation.created_at DESC, confirmation.confirmation_id DESC
    LIMIT 1;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF app.merge_value_is_blank(v_account_value)
       AND NOT app.merge_value_is_blank(v_guest_value) THEN
      v_merged_profile := jsonb_set(
        v_merged_profile,
        v_field.json_path,
        v_guest_value,
        true
      );
      v_profile_changed := true;
    ELSIF NOT app.merge_value_is_blank(v_account_value)
       AND NOT app.merge_value_is_blank(v_guest_value)
       AND v_account_value IS DISTINCT FROM v_guest_value THEN
      INSERT INTO app.profile_merge_conflicts (
        merge_id,
        field_path,
        account_value,
        guest_value,
        account_updated_at,
        guest_updated_at,
        account_stale_over_30_days,
        resolution_status,
        created_at
      )
      VALUES (
        v_merge_id,
        v_field.field_path,
        v_account_value,
        v_guest_value,
        v_account_updated_at,
        v_guest_updated_at,
        v_account_updated_at IS NOT NULL
          AND v_account_updated_at < v_merged_at - interval '30 days',
        'pending',
        v_merged_at
      );
    END IF;
  END LOOP;

  IF v_profile_changed THEN
    PERFORM app.save_current_user_profile(v_merged_profile, 'system');
  END IF;

  -- 先处理所有非纠错事件，建立 source -> target 映射。
  FOR v_event IN
    SELECT ue.*
    FROM app.user_events AS ue
    WHERE ue.user_id = v_source_user_id
      AND ue.event_type <> 'user_correction'
    ORDER BY ue.recorded_at, ue.event_id
  LOOP
    v_event_hash := app.user_event_merge_fingerprint(
      v_event.event_type,
      v_event.occurred_at,
      v_event.payload,
      NULL
    );
    v_duplicate_event_id := NULL;
    v_duplicate_event_type := NULL;
    v_duplicate_event_hash := NULL;

    IF v_event.idempotency_key IS NOT NULL THEN
      SELECT
        ue.event_id,
        ue.event_type,
        app.user_event_merge_fingerprint(
          ue.event_type,
          ue.occurred_at,
          ue.payload,
          NULL
        )
      INTO v_duplicate_event_id, v_duplicate_event_type, v_duplicate_event_hash
      FROM app.user_events AS ue
      WHERE ue.user_id = v_target_user_id
        AND ue.idempotency_key = v_event.idempotency_key
      LIMIT 1;

      IF FOUND AND (
        v_duplicate_event_type IS DISTINCT FROM v_event.event_type
        OR v_duplicate_event_hash IS DISTINCT FROM v_event_hash
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = '合并事件的幂等键与目标账号事件语义冲突';
      END IF;
    END IF;

    IF v_duplicate_event_id IS NULL THEN
      SELECT ue.event_id INTO v_duplicate_event_id
      FROM app.user_events AS ue
      WHERE ue.user_id = v_target_user_id
        AND ue.event_type <> 'user_correction'
        AND app.user_event_merge_fingerprint(
          ue.event_type,
          ue.occurred_at,
          ue.payload,
          NULL
        ) = v_event_hash
      ORDER BY ue.recorded_at, ue.event_id
      LIMIT 1;
    END IF;

    IF v_duplicate_event_id IS NOT NULL THEN
      v_target_event_id := v_duplicate_event_id;
      v_action := 'deduplicated';
    ELSE
      v_target_event_id := replace(public.gen_random_uuid()::text, '-', '');
      v_action := CASE
        WHEN v_event.event_type IN ('menstrual_period_start', 'menstrual_symptom')
          THEN 'migrated_restricted'
        ELSE 'migrated'
      END;

      INSERT INTO app.user_events (
        event_id,
        user_id,
        event_type,
        occurred_at,
        recorded_at,
        payload,
        source,
        idempotency_key,
        supersedes_event_id,
        status
      )
      VALUES (
        v_target_event_id,
        v_target_user_id,
        v_event.event_type,
        v_event.occurred_at,
        v_event.recorded_at,
        v_event.payload,
        v_event.source,
        v_event.idempotency_key,
        NULL,
        CASE
          WHEN v_event.event_type IN ('menstrual_period_start', 'menstrual_symptom')
            THEN 'restricted_pending_consent'
          ELSE 'active'
        END
      );
    END IF;

    INSERT INTO app.event_merge_audit (
      merge_id,
      source_event_id,
      target_event_id,
      action,
      event_hash,
      created_at
    )
    VALUES (
      v_merge_id,
      v_event.event_id,
      v_target_event_id,
      v_action,
      v_event_hash,
      v_merged_at
    );
  END LOOP;

  -- 纠错可以引用另一条纠错，因此分轮处理已有映射的引用。
  LOOP
    v_progress := 0;

    FOR v_event IN
      SELECT ue.*
      FROM app.user_events AS ue
      WHERE ue.user_id = v_source_user_id
        AND ue.event_type = 'user_correction'
        AND NOT EXISTS (
          SELECT 1
          FROM app.event_merge_audit AS ema
          WHERE ema.merge_id = v_merge_id
            AND ema.source_event_id = ue.event_id
        )
      ORDER BY ue.recorded_at, ue.event_id
    LOOP
      SELECT ema.target_event_id, target_event.status
      INTO v_target_supersedes_event_id, v_target_supersedes_status
      FROM app.event_merge_audit AS ema
      JOIN app.user_events AS target_event
        ON target_event.event_id = ema.target_event_id
       AND target_event.user_id = v_target_user_id
      WHERE ema.merge_id = v_merge_id
        AND ema.source_event_id = v_event.supersedes_event_id;

      IF v_target_supersedes_event_id IS NULL THEN
        CONTINUE;
      END IF;

      v_event_hash := app.user_event_merge_fingerprint(
        v_event.event_type,
        v_event.occurred_at,
        v_event.payload,
        v_target_supersedes_event_id
      );
      v_duplicate_event_id := NULL;
      v_duplicate_event_type := NULL;
      v_duplicate_supersedes_event_id := NULL;
      v_duplicate_event_hash := NULL;

      IF v_event.idempotency_key IS NOT NULL THEN
        SELECT
          ue.event_id,
          ue.event_type,
          ue.supersedes_event_id,
          app.user_event_merge_fingerprint(
            ue.event_type,
            ue.occurred_at,
            ue.payload,
            ue.supersedes_event_id
          )
        INTO
          v_duplicate_event_id,
          v_duplicate_event_type,
          v_duplicate_supersedes_event_id,
          v_duplicate_event_hash
        FROM app.user_events AS ue
        WHERE ue.user_id = v_target_user_id
          AND ue.idempotency_key = v_event.idempotency_key
        LIMIT 1;

        IF FOUND AND (
          v_duplicate_event_type IS DISTINCT FROM 'user_correction'
          OR v_duplicate_supersedes_event_id IS DISTINCT FROM v_target_supersedes_event_id
          OR v_duplicate_event_hash IS DISTINCT FROM v_event_hash
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23505',
            MESSAGE = '合并纠错事件的幂等键与目标账号事件语义冲突';
        END IF;
      END IF;

      IF v_duplicate_event_id IS NULL THEN
        SELECT ue.event_id INTO v_duplicate_event_id
        FROM app.user_events AS ue
        WHERE ue.user_id = v_target_user_id
          AND ue.event_type = 'user_correction'
          AND app.user_event_merge_fingerprint(
            ue.event_type,
            ue.occurred_at,
            ue.payload,
            ue.supersedes_event_id
          ) = v_event_hash
        ORDER BY ue.recorded_at, ue.event_id
        LIMIT 1;
      END IF;

      IF v_duplicate_event_id IS NOT NULL THEN
        v_target_event_id := v_duplicate_event_id;
        v_action := 'deduplicated';
      ELSE
        v_target_event_id := replace(public.gen_random_uuid()::text, '-', '');
        v_action := CASE
          WHEN v_target_supersedes_status = 'restricted_pending_consent'
            THEN 'migrated_restricted'
          ELSE 'migrated'
        END;

        INSERT INTO app.user_events (
          event_id,
          user_id,
          event_type,
          occurred_at,
          recorded_at,
          payload,
          source,
          idempotency_key,
          supersedes_event_id,
          status
        )
        VALUES (
          v_target_event_id,
          v_target_user_id,
          v_event.event_type,
          v_event.occurred_at,
          v_event.recorded_at,
          v_event.payload,
          v_event.source,
          v_event.idempotency_key,
          v_target_supersedes_event_id,
          CASE
            WHEN v_target_supersedes_status = 'restricted_pending_consent'
              THEN 'restricted_pending_consent'
            ELSE 'active'
          END
        );
      END IF;

      INSERT INTO app.event_merge_audit (
        merge_id,
        source_event_id,
        target_event_id,
        action,
        event_hash,
        created_at
      )
      VALUES (
        v_merge_id,
        v_event.event_id,
        v_target_event_id,
        v_action,
        v_event_hash,
        v_merged_at
      );

      v_progress := v_progress + 1;
    END LOOP;

    SELECT COUNT(*) INTO v_remaining
    FROM app.user_events AS ue
    WHERE ue.user_id = v_source_user_id
      AND ue.event_type = 'user_correction'
      AND NOT EXISTS (
        SELECT 1
        FROM app.event_merge_audit AS ema
        WHERE ema.merge_id = v_merge_id
          AND ema.source_event_id = ue.event_id
      );

    EXIT WHEN v_remaining = 0;

    IF v_progress = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = '纠错事件的原记录无法映射到目标账号';
    END IF;
  END LOOP;

  UPDATE app.user_identities
  SET user_id = v_target_user_id,
      last_seen_at = GREATEST(last_seen_at, v_merged_at)
  WHERE user_id = v_source_user_id;

  UPDATE app.users
  SET status = 'merged',
      merged_into_user_id = v_target_user_id,
      updated_at = v_merged_at
  WHERE user_id = v_source_user_id;

  RETURN jsonb_build_object(
    'mergeId', v_merge_id,
    'sourceUserId', v_source_user_id,
    'targetUserId', v_target_user_id,
    'status', 'completed',
    'mergedAt', v_merged_at,
    'idempotentReplay', false,
    'profileConflictCount', (
      SELECT COUNT(*)
      FROM app.profile_merge_conflicts
      WHERE merge_id = v_merge_id
    ),
    'migratedEventCount', (
      SELECT COUNT(*)
      FROM app.event_merge_audit
      WHERE merge_id = v_merge_id
        AND action IN ('migrated', 'migrated_restricted')
    ),
    'deduplicatedEventCount', (
      SELECT COUNT(*)
      FROM app.event_merge_audit
      WHERE merge_id = v_merge_id
        AND action = 'deduplicated'
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.get_current_user_merge(
  p_source_user_id varchar
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT jsonb_build_object(
    'mergeId', um.merge_id,
    'sourceUserId', um.source_user_id,
    'targetUserId', um.target_user_id,
    'status', um.status,
    'mergedAt', um.merged_at
  )
  FROM app.user_merges AS um
  WHERE um.source_user_id = btrim(p_source_user_id)
    AND um.target_user_id = app.current_user_id();
$function$;

CREATE OR REPLACE FUNCTION app.get_current_merge_review(
  p_merge_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT jsonb_build_object(
    'mergeId', um.merge_id,
    'conflicts', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'conflictId', pmc.conflict_id,
            'fieldPath', pmc.field_path,
            'accountValue', pmc.account_value,
            'guestValue', pmc.guest_value,
            'accountUpdatedAt', pmc.account_updated_at,
            'guestUpdatedAt', pmc.guest_updated_at,
            'accountStaleOver30Days', pmc.account_stale_over_30_days,
            'resolutionStatus', pmc.resolution_status,
            'createdAt', pmc.created_at
          )
          ORDER BY pmc.created_at, pmc.conflict_id
        )
        FROM app.profile_merge_conflicts AS pmc
        WHERE pmc.merge_id = um.merge_id
      ),
      '[]'::jsonb
    ),
    'eventAudit', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'sourceEventId', ema.source_event_id,
            'targetEventId', ema.target_event_id,
            'action', ema.action,
            'eventHash', ema.event_hash,
            'createdAt', ema.created_at
          )
          ORDER BY ema.created_at, ema.audit_id
        )
        FROM app.event_merge_audit AS ema
        WHERE ema.merge_id = um.merge_id
      ),
      '[]'::jsonb
    ),
    'pendingConflictCount', (
      SELECT COUNT(*)
      FROM app.profile_merge_conflicts AS pending
      WHERE pending.merge_id = um.merge_id
        AND pending.resolution_status = 'pending'
    )
  )
  FROM app.user_merges AS um
  WHERE um.merge_id = p_merge_id
    AND um.target_user_id = app.current_user_id();
$function$;

CREATE OR REPLACE FUNCTION app.release_current_merged_sensitive_events(
  p_merge_id uuid
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_merged_at timestamptz;
  v_consent_status varchar;
  v_consent_recorded_at timestamptz;
  v_consent_created_at timestamptz;
  v_released integer;
BEGIN
  SELECT um.merged_at
  INTO v_merged_at
  FROM app.user_merges AS um
  WHERE um.merge_id = p_merge_id
    AND um.target_user_id = v_user_id;

  IF v_merged_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '当前用户无权释放该合并的敏感历史';
  END IF;

  SELECT uc.status, uc.recorded_at, uc.created_at
  INTO v_consent_status, v_consent_recorded_at, v_consent_created_at
  FROM app.user_consents AS uc
  WHERE uc.user_id = v_user_id
    AND uc.consent_type = 'menstrual_tracking'
  -- 最新状态按数据库入库时间判断；recorded_at 只作为业务时间的附加门槛。
  ORDER BY uc.created_at DESC, uc.consent_id DESC
  LIMIT 1;

  IF v_consent_status IS DISTINCT FROM 'granted'
     OR v_consent_recorded_at < v_merged_at
     OR v_consent_created_at < v_merged_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '必须在合并后重新授权才能释放迁入的经期历史';
  END IF;

  UPDATE app.user_events AS ue
  SET status = 'active'
  FROM app.event_merge_audit AS ema
  WHERE ema.merge_id = p_merge_id
    AND ema.action = 'migrated_restricted'
    AND ema.target_event_id = ue.event_id
    AND ue.user_id = v_user_id
    AND ue.status = 'restricted_pending_consent';

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$function$;

ALTER FUNCTION app.merge_value_is_blank(jsonb) OWNER TO diet_owner;
ALTER FUNCTION app.begin_current_long_term_profile_confirmation(
  varchar, varchar, jsonb, timestamptz
) OWNER TO diet_owner;
ALTER FUNCTION app.save_current_long_term_profile_fields(
  jsonb, jsonb, uuid, varchar, timestamptz
) OWNER TO diet_owner;
ALTER FUNCTION app.profile_snapshot_for_merge(varchar) OWNER TO diet_owner;
ALTER FUNCTION app.user_event_merge_fingerprint(varchar, timestamptz, jsonb, varchar)
  OWNER TO diet_owner;
ALTER FUNCTION app.resolve_anonymous_identity(varchar, varchar) OWNER TO diet_owner;
ALTER FUNCTION app.merge_current_account_from_anonymous(varchar) OWNER TO diet_owner;
ALTER FUNCTION app.get_current_user_merge(varchar) OWNER TO diet_owner;
ALTER FUNCTION app.get_current_merge_review(uuid) OWNER TO diet_owner;
ALTER FUNCTION app.release_current_merged_sensitive_events(uuid) OWNER TO diet_owner;

REVOKE ALL ON FUNCTION app.merge_value_is_blank(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.begin_current_long_term_profile_confirmation(
  varchar, varchar, jsonb, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.save_current_long_term_profile_fields(
  jsonb, jsonb, uuid, varchar, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.profile_snapshot_for_merge(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.user_event_merge_fingerprint(varchar, timestamptz, jsonb, varchar)
FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_anonymous_identity(varchar, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.merge_current_account_from_anonymous(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_current_user_merge(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_current_merge_review(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.release_current_merged_sensitive_events(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_anonymous_identity(varchar, varchar)
TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.begin_current_long_term_profile_confirmation(
  varchar, varchar, jsonb, timestamptz
) TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.save_current_long_term_profile_fields(
  jsonb, jsonb, uuid, varchar, timestamptz
) TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.merge_current_account_from_anonymous(varchar)
TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.get_current_user_merge(varchar)
TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.get_current_merge_review(uuid)
TO diet_app, diet_owner;
GRANT EXECUTE ON FUNCTION app.release_current_merged_sensitive_events(uuid)
TO diet_app, diet_owner;

COMMENT ON FUNCTION app.merge_current_account_from_anonymous(varchar) IS
  '将anon游客原子合并到当前已认证acct账号；账号档案优先，事件追加去重，敏感历史待合并后重新授权。';

COMMENT ON FUNCTION app.save_current_long_term_profile_fields(
  jsonb, jsonb, uuid, varchar, timestamptz
) IS
  '消费一次性确认请求，并原子保存档案、修订和字段确认事实。';

COMMENT ON FUNCTION app.begin_current_long_term_profile_confirmation(
  varchar, varchar, jsonb, timestamptz
) IS
  '记录秘书在长期建档中主动展示的字段与值，生成一次性待确认请求，不保存对话原文。';

COMMIT;

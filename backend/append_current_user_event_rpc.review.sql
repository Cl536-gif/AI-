-- REVIEW ONLY — 审核通过后再复制到腾讯云 DMC 执行。
-- 作用：以当前业务身份原子追加一条用户事件，并支持幂等重试。
-- 安全边界：
-- 1. user_id 只从 app.current_user_id() 读取，客户端不能传入。
-- 2. RLS 继续负责“只能操作本人数据”及经期事件的单独授权检查。
-- 3. 本函数只做追加，不提供更新或删除历史事件的能力。

BEGIN;

CREATE OR REPLACE FUNCTION app.append_current_user_event(
  p_event jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_unknown_keys text[];
  v_event_id varchar;
  v_event_type varchar;
  v_occurred_at timestamptz;
  v_recorded_at timestamptz;
  v_payload jsonb;
  v_source varchar;
  v_idempotency_key varchar;
  v_supersedes_event_id varchar;
  v_existing app.user_events%ROWTYPE;
  v_saved app.user_events%ROWTYPE;
BEGIN
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = '事件必须是 JSON 对象';
  END IF;

  -- userDataContract.js 的 UserEventSchema 顶层字段白名单。
  -- userId 故意不在白名单内，避免客户端伪造身份。
  SELECT array_agg(k ORDER BY k)
  INTO v_unknown_keys
  FROM jsonb_object_keys(p_event) AS keys(k)
  WHERE k <> ALL (ARRAY[
    'eventId',
    'eventType',
    'occurredAt',
    'recordedAt',
    'payload',
    'source',
    'idempotencyKey',
    'supersedesEventId'
  ]::text[]);

  IF v_unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = format(
        '事件包含不支持的字段：%s',
        array_to_string(v_unknown_keys, ', ')
      );
  END IF;

  v_event_id := NULLIF(btrim(p_event ->> 'eventId'), '');
  v_event_type := NULLIF(btrim(p_event ->> 'eventType'), '');
  v_source := COALESCE(NULLIF(btrim(p_event ->> 'source'), ''), 'user');
  v_idempotency_key := NULLIF(btrim(p_event ->> 'idempotencyKey'), '');
  v_supersedes_event_id := NULLIF(btrim(p_event ->> 'supersedesEventId'), '');
  v_payload := p_event -> 'payload';

  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '28000',
      MESSAGE = '当前请求缺少有效用户身份';
  END IF;

  IF v_event_type IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'eventType不能为空';
  END IF;

  IF NOT (p_event ? 'occurredAt')
     OR NULLIF(btrim(p_event ->> 'occurredAt'), '') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'occurredAt不能为空';
  END IF;

  BEGIN
    v_occurred_at := (p_event ->> 'occurredAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION USING
      ERRCODE = '22007',
      MESSAGE = 'occurredAt必须是包含时区的有效日期时间';
  END;

  IF p_event ? 'recordedAt'
     AND NULLIF(btrim(p_event ->> 'recordedAt'), '') IS NOT NULL THEN
    BEGIN
      v_recorded_at := (p_event ->> 'recordedAt')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION USING
        ERRCODE = '22007',
        MESSAGE = 'recordedAt必须是包含时区的有效日期时间';
    END;
  ELSE
    v_recorded_at := clock_timestamp();
  END IF;

  IF v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'payload必须是 JSON 对象';
  END IF;

  IF octet_length(v_payload::text) > 50 * 1024 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22001',
      MESSAGE = '事件内容不能超过50KB';
  END IF;

  IF v_event_id IS NOT NULL AND char_length(v_event_id) > 128 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22001',
      MESSAGE = 'eventId长度不能超过128';
  END IF;

  IF v_idempotency_key IS NOT NULL
     AND char_length(v_idempotency_key) > 200 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22001',
      MESSAGE = 'idempotencyKey长度不能超过200';
  END IF;

  IF v_supersedes_event_id IS NOT NULL
     AND char_length(v_supersedes_event_id) > 128 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22001',
      MESSAGE = 'supersedesEventId长度不能超过128';
  END IF;

  IF v_event_type <> ALL (ARRAY[
    'meal',
    'snack',
    'body_measurement',
    'exercise',
    'menstrual_period_start',
    'menstrual_symptom',
    'check_in',
    'plan_interruption',
    'user_correction'
  ]::varchar[]) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'eventType不在允许范围内';
  END IF;

  IF v_source <> ALL (ARRAY[
    'user',
    'secretary',
    'device',
    'import',
    'system'
  ]::varchar[]) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'source不在允许范围内';
  END IF;

  IF v_event_type = 'user_correction'
     AND v_supersedes_event_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = '用户纠错事件必须指定supersedesEventId';
  END IF;

  -- 同一用户和幂等键串行化，防止并发重试生成两条事件。
  IF v_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        jsonb_build_array(v_user_id, v_idempotency_key)::text,
        0
      )
    );

    SELECT ue.*
    INTO v_existing
    FROM app.user_events AS ue
    WHERE ue.user_id = v_user_id
      AND ue.idempotency_key = v_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'eventId', v_existing.event_id,
        'eventType', v_existing.event_type,
        'occurredAt', v_existing.occurred_at,
        'recordedAt', v_existing.recorded_at,
        'payload', v_existing.payload,
        'source', v_existing.source,
        'idempotencyKey', v_existing.idempotency_key,
        'supersedesEventId', v_existing.supersedes_event_id
      );
    END IF;
  END IF;

  INSERT INTO app.user_events (
    event_id,
    user_id,
    event_type,
    occurred_at,
    recorded_at,
    payload,
    source,
    idempotency_key,
    supersedes_event_id
  )
  VALUES (
    COALESCE(v_event_id, public.gen_random_uuid()::text),
    v_user_id,
    v_event_type,
    v_occurred_at,
    v_recorded_at,
    v_payload,
    v_source,
    v_idempotency_key,
    v_supersedes_event_id
  )
  RETURNING * INTO v_saved;

  RETURN jsonb_build_object(
    'eventId', v_saved.event_id,
    'eventType', v_saved.event_type,
    'occurredAt', v_saved.occurred_at,
    'recordedAt', v_saved.recorded_at,
    'payload', v_saved.payload,
    'source', v_saved.source,
    'idempotencyKey', v_saved.idempotency_key,
    'supersedesEventId', v_saved.supersedes_event_id
  );
END;
$function$;

ALTER FUNCTION app.append_current_user_event(jsonb)
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.append_current_user_event(jsonb)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app.append_current_user_event(jsonb)
TO diet_app, diet_owner;

COMMENT ON FUNCTION app.append_current_user_event(jsonb) IS
  '追加当前用户事件；身份从app.current_user_id()读取；支持幂等重试；经期事件仍受RLS单独授权约束。';

COMMIT;

-- 审核重点：
-- 1. 入参没有 user_id；出现 userId 会被顶层白名单拒绝。
-- 2. eventType/source 白名单与 userDataContract.js 完全一致。
-- 3. payload 目前保持灵活对象，但限制为对象且不超过50KB。
-- 4. user_correction 必须引用 supersedesEventId；同用户外键由表约束兜底。
-- 5. 幂等键使用事务级 advisory lock，避免并发重试产生重复事件。
-- 6. menstrual_period_start / menstrual_symptom 的授权继续由RLS检查。

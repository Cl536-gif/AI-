-- REVIEW ONLY: 004k 建议历史持久化。
-- 前置：001-004j 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE TABLE app.user_advice_history (
  advice_id varchar(128) PRIMARY KEY
    DEFAULT public.gen_random_uuid()::text,
  user_id varchar NOT NULL
    REFERENCES app.users(user_id) ON DELETE CASCADE,
  advice_type varchar(64) NOT NULL,
  service_mode varchar(64) NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  thread_id varchar(256),
  idempotency_key varchar(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_advice_history_user_idempotency_unique
    UNIQUE (user_id, idempotency_key),
  CONSTRAINT user_advice_history_advice_type_chk CHECK (
    char_length(btrim(advice_type)) BETWEEN 1 AND 64
  ),
  CONSTRAINT user_advice_history_service_mode_chk CHECK (
    char_length(btrim(service_mode)) BETWEEN 1 AND 64
  ),
  CONSTRAINT user_advice_history_content_chk CHECK (
    char_length(btrim(content)) > 0 AND octet_length(content) <= 131072
  ),
  CONSTRAINT user_advice_history_metadata_chk CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 65536
  ),
  CONSTRAINT user_advice_history_thread_id_chk CHECK (
    thread_id IS NULL OR char_length(btrim(thread_id)) BETWEEN 1 AND 256
  ),
  CONSTRAINT user_advice_history_idempotency_key_chk CHECK (
    char_length(btrim(idempotency_key)) BETWEEN 1 AND 256
  )
);

CREATE INDEX user_advice_history_user_time_idx
  ON app.user_advice_history (user_id, created_at DESC, advice_id DESC);

ALTER TABLE app.user_advice_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_advice_history NO FORCE ROW LEVEL SECURITY;

CREATE POLICY user_advice_history_select_own
ON app.user_advice_history FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

REVOKE ALL ON TABLE app.user_advice_history FROM PUBLIC, diet_app;
GRANT SELECT ON TABLE app.user_advice_history TO diet_app;

CREATE OR REPLACE FUNCTION app.record_current_user_advice(
  p_advice jsonb,
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
  v_advice_type varchar;
  v_service_mode varchar;
  v_content text;
  v_metadata jsonb;
  v_thread_id varchar;
  v_idempotency_key varchar;
  v_created_at timestamptz := COALESCE(p_created_at, clock_timestamp());
  v_saved app.user_advice_history%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF p_advice IS NULL OR jsonb_typeof(p_advice) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '建议记录格式不正确';
  END IF;

  IF octet_length(p_advice::text) > 196608 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '建议记录过大';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_advice) AS next_key(key_name)
    WHERE key_name NOT IN (
      'adviceType',
      'serviceMode',
      'content',
      'metadata',
      'threadId',
      'idempotencyKey'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '建议记录包含未知字段';
  END IF;

  IF (p_advice ? 'adviceType' AND jsonb_typeof(p_advice->'adviceType') <> 'string')
     OR (p_advice ? 'serviceMode' AND jsonb_typeof(p_advice->'serviceMode') <> 'string')
     OR jsonb_typeof(p_advice->'content') IS DISTINCT FROM 'string'
     OR (p_advice ? 'metadata' AND jsonb_typeof(p_advice->'metadata') <> 'object')
     OR (p_advice ? 'threadId' AND jsonb_typeof(p_advice->'threadId') NOT IN ('string', 'null'))
     OR jsonb_typeof(p_advice->'idempotencyKey') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '建议记录字段类型不正确';
  END IF;

  v_advice_type := COALESCE(NULLIF(btrim(p_advice->>'adviceType'), ''), 'meal_advice');
  v_service_mode := COALESCE(NULLIF(btrim(p_advice->>'serviceMode'), ''), 'free');
  v_content := NULLIF(btrim(p_advice->>'content'), '');
  v_metadata := COALESCE(p_advice->'metadata', '{}'::jsonb);
  v_thread_id := NULLIF(btrim(p_advice->>'threadId'), '');
  v_idempotency_key := NULLIF(btrim(p_advice->>'idempotencyKey'), '');

  IF char_length(v_advice_type) > 64
     OR char_length(v_service_mode) > 64
     OR v_content IS NULL OR octet_length(v_content) > 131072
     OR octet_length(v_metadata::text) > 65536
     OR char_length(COALESCE(v_thread_id, '')) > 256
     OR v_idempotency_key IS NULL OR char_length(v_idempotency_key) > 256 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '建议记录字段不正确';
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

  INSERT INTO app.user_advice_history (
    user_id,
    advice_type,
    service_mode,
    content,
    metadata,
    thread_id,
    idempotency_key,
    created_at
  ) VALUES (
    v_user_id,
    v_advice_type,
    v_service_mode,
    v_content,
    v_metadata,
    v_thread_id,
    v_idempotency_key,
    v_created_at
  )
  ON CONFLICT (user_id, idempotency_key) DO UPDATE
  SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING * INTO v_saved;

  RETURN jsonb_build_object(
    'adviceId', v_saved.advice_id,
    'userId', v_saved.user_id,
    'adviceType', v_saved.advice_type,
    'serviceMode', v_saved.service_mode,
    'content', v_saved.content,
    'metadata', v_saved.metadata,
    'threadId', v_saved.thread_id,
    'idempotencyKey', v_saved.idempotency_key,
    'createdAt', v_saved.created_at
  );
END;
$function$;

ALTER FUNCTION app.record_current_user_advice(jsonb, timestamptz)
OWNER TO diet_owner;
REVOKE ALL ON FUNCTION app.record_current_user_advice(jsonb, timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_current_user_advice(jsonb, timestamptz)
TO diet_app, diet_owner;

COMMENT ON TABLE app.user_advice_history IS
  '不可变的用户建议历史；当前用户仅可读取本人记录，写入必须经过受控幂等函数。';
COMMENT ON FUNCTION app.record_current_user_advice(jsonb, timestamptz) IS
  '为当前active用户幂等记录一条经过形状与大小校验的建议历史。';

COMMIT;

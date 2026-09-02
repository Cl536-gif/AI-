-- REVIEW ONLY — 审核通过后再复制到腾讯云 DMC 执行。
-- 作用：以当前数据库会话中的用户身份，追加一条授权状态记录。
-- 授权历史只追加、不覆盖；当前有效状态由 recorded_at DESC、consent_id DESC 的最新记录决定。

BEGIN;

CREATE OR REPLACE FUNCTION app.record_current_user_consent(
  p_consent jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar;
  v_consent_id uuid;
  v_consent_type varchar;
  v_status varchar;
  v_recorded_at timestamptz;
  v_source varchar;
BEGIN
  v_user_id := app.current_user_id();

  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION '当前请求缺少有效用户身份'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.users AS u
    WHERE u.user_id = v_user_id
      AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION '当前用户不存在或已不可用'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_consent IS NULL OR jsonb_typeof(p_consent) <> 'object' THEN
    RAISE EXCEPTION '授权命令必须是 JSON 对象'
      USING ERRCODE = 'P0001';
  END IF;

  -- 与 ConsentSchema 保持一致；userId 不能由调用方传入。
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_consent) AS k(key)
    WHERE k.key <> ALL (
      ARRAY['consentType', 'status', 'recordedAt', 'source']::text[]
    )
  ) THEN
    RAISE EXCEPTION '授权命令包含不支持的字段'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT (p_consent ? 'consentType')
     OR NOT (p_consent ? 'status')
     OR NOT (p_consent ? 'recordedAt') THEN
    RAISE EXCEPTION '授权命令缺少 consentType、status 或 recordedAt'
      USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(p_consent -> 'consentType') <> 'string'
     OR jsonb_typeof(p_consent -> 'status') <> 'string'
     OR jsonb_typeof(p_consent -> 'recordedAt') <> 'string'
     OR (
       p_consent ? 'source'
       AND jsonb_typeof(p_consent -> 'source') NOT IN ('string', 'null')
     ) THEN
    RAISE EXCEPTION '授权命令字段类型不正确'
      USING ERRCODE = 'P0001';
  END IF;

  v_consent_type := p_consent ->> 'consentType';
  v_status := p_consent ->> 'status';
  v_source := COALESCE(p_consent ->> 'source', 'user');

  BEGIN
    v_recorded_at := (p_consent ->> 'recordedAt')::timestamptz;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'recordedAt 必须是带时区的有效时间'
        USING ERRCODE = 'P0001';
  END;

  IF v_consent_type NOT IN (
    'long_term_profile',
    'menstrual_tracking',
    'proactive_reminders'
  ) THEN
    RAISE EXCEPTION '不支持的 consentType'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_status NOT IN ('granted', 'declined', 'revoked') THEN
    RAISE EXCEPTION '不支持的授权状态'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_source NOT IN ('user', 'system') THEN
    RAISE EXCEPTION '不支持的授权来源'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.user_consents (
    user_id,
    consent_type,
    status,
    recorded_at,
    source
  )
  VALUES (
    v_user_id,
    v_consent_type,
    v_status,
    v_recorded_at,
    v_source
  )
  RETURNING consent_id
  INTO v_consent_id;

  RETURN jsonb_build_object(
    'consentId', v_consent_id,
    'userId', v_user_id,
    'consentType', v_consent_type,
    'status', v_status,
    'recordedAt', v_recorded_at,
    'source', v_source
  );
END;
$function$;

ALTER FUNCTION app.record_current_user_consent(jsonb)
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.record_current_user_consent(jsonb)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app.record_current_user_consent(jsonb)
TO diet_app, diet_owner;

COMMENT ON FUNCTION app.record_current_user_consent(jsonb) IS
  '为当前用户追加授权历史记录；不接受调用方指定 userId。输入字段使用 ConsentSchema 的 camelCase 契约。';

COMMIT;

-- 审核重点：
-- 1. 入参没有 user_id，用户身份只读取 app.current_user_id()。
-- 2. 只允许 ConsentSchema 中的 consentType、status、recordedAt、source。
-- 3. 授权记录只 INSERT，不 UPDATE/DELETE；撤回与重新授权都追加新记录。
-- 4. menstrual_tracking 撤回后历史敏感数据仍保留，但 RLS/业务层不再允许读取使用；重新授权后恢复。
-- 5. 后续新增授权类型时，必须同步修改 userDataContract.js、建表 CHECK 和本函数白名单。

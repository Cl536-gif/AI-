-- REVIEW ONLY — 审核通过后再复制到腾讯云 DMC 执行。
-- 作用：在同一个数据库事务中更新当前用户的经期档案，并追加一条经期历史快照。
-- 安全边界：
-- 1. 不接受 user_id 入参，用户身份只能来自 app.current_user_id()。
-- 2. 必须存在当前有效的 menstrual_tracking 授权。
-- 3. 经期数据只写入独立经期表，禁止混入普通 user_profiles/profile_revisions。

BEGIN;

CREATE OR REPLACE FUNCTION app.save_current_user_menstrual_profile(
  p_menstrual_profile jsonb,
  p_source varchar DEFAULT 'user'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar;
  v_applicability varchar;
  v_status varchar;
  v_snapshot jsonb;
  v_unknown_keys text[];
BEGIN
  v_user_id := app.current_user_id();

  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION '缺少当前用户身份，不能保存经期档案'
      USING ERRCODE = '42501';
  END IF;

  IF NOT app.current_user_has_consent('menstrual_tracking') THEN
    RAISE EXCEPTION '缺少当前有效的 menstrual_tracking 授权，不能保存经期档案'
      USING ERRCODE = '42501';
  END IF;

  IF p_menstrual_profile IS NULL
     OR jsonb_typeof(p_menstrual_profile) <> 'object' THEN
    RAISE EXCEPTION 'p_menstrual_profile 必须是 JSON 对象';
  END IF;

  -- 与 userDataContract.js 的 MenstrualTrackingSchema 严格保持一致。
  SELECT array_agg(k ORDER BY k)
  INTO v_unknown_keys
  FROM jsonb_object_keys(p_menstrual_profile) AS keys(k)
  WHERE k NOT IN ('applicability', 'status');

  IF v_unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION '经期档案包含未允许字段: %',
      array_to_string(v_unknown_keys, ', ');
  END IF;

  IF NOT (p_menstrual_profile ? 'applicability')
     OR jsonb_typeof(p_menstrual_profile -> 'applicability') <> 'string' THEN
    RAISE EXCEPTION 'applicability 必须是字符串且不可缺失';
  END IF;

  IF NOT (p_menstrual_profile ? 'status')
     OR jsonb_typeof(p_menstrual_profile -> 'status') <> 'string' THEN
    RAISE EXCEPTION 'status 必须是字符串且不可缺失';
  END IF;

  v_applicability := p_menstrual_profile ->> 'applicability';
  v_status := p_menstrual_profile ->> 'status';

  IF v_applicability NOT IN (
    'applicable',
    'not_applicable',
    'unknown'
  ) THEN
    RAISE EXCEPTION 'applicability 值不符合契约: %', v_applicability;
  END IF;

  IF v_status NOT IN (
    'pending',
    'active',
    'declined',
    'unknown'
  ) THEN
    RAISE EXCEPTION 'status 值不符合契约: %', v_status;
  END IF;

  IF p_source IS NULL
     OR p_source NOT IN ('user', 'secretary', 'system') THEN
    RAISE EXCEPTION 'p_source 值不符合契约: %', p_source;
  END IF;

  INSERT INTO app.user_menstrual_profiles (
    user_id,
    applicability,
    status
  )
  VALUES (
    v_user_id,
    v_applicability,
    v_status
  )
  ON CONFLICT (user_id) DO UPDATE SET
    applicability = EXCLUDED.applicability,
    status = EXCLUDED.status,
    updated_at = clock_timestamp();

  -- 从数据库已保存的规范值生成快照，不直接信任输入 JSON。
  SELECT jsonb_build_object(
    'applicability', ump.applicability,
    'status', ump.status
  )
  INTO v_snapshot
  FROM app.user_menstrual_profiles AS ump
  WHERE ump.user_id = v_user_id;

  -- 与上面的 UPSERT 同属一个函数调用；这里失败时，档案更新也会一起回滚。
  INSERT INTO app.menstrual_profile_revisions (
    user_id,
    menstrual_snapshot,
    source
  )
  VALUES (
    v_user_id,
    v_snapshot,
    p_source
  );

  RETURN v_snapshot;
END;
$function$;

ALTER FUNCTION app.save_current_user_menstrual_profile(jsonb, varchar)
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.save_current_user_menstrual_profile(jsonb, varchar)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app.save_current_user_menstrual_profile(jsonb, varchar)
TO diet_app, diet_owner;

COMMENT ON FUNCTION app.save_current_user_menstrual_profile(jsonb, varchar) IS
  '原子保存经期档案并追加独立经期历史快照；要求当前有效的 menstrual_tracking 授权。';

COMMIT;

-- 审核重点：
-- 1. 入参只有 p_menstrual_profile 与 p_source，没有可由客户端伪造的 user_id。
-- 2. 输入白名单只允许 applicability 与 status，枚举值与 userDataContract.js 一致。
-- 3. 函数在写入前再次检查最新 menstrual_tracking 授权。
-- 4. 快照从数据库规范值生成，并且只进入 menstrual_profile_revisions。
-- 5. UPSERT 与历史 INSERT 原子执行；历史写入失败时当前档案也一起回滚。
-- 6. 以后增加经期字段时，必须同步修改：userDataContract.js、建表迁移、此 RPC 和测试。

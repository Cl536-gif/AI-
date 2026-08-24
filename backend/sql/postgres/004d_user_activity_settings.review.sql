-- REVIEW ONLY: 004d 用户活跃时间与设置。
-- 前置：001-004c 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

ALTER TABLE app.users
  ADD COLUMN last_active_at timestamptz,
  ADD COLUMN timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  ADD COLUMN locale varchar(16) NOT NULL DEFAULT 'zh-CN';

-- 既有用户以最近的用户行更新时间作为迁移基线，不伪造更精确的活跃时间。
UPDATE app.users
SET last_active_at = COALESCE(updated_at, created_at, clock_timestamp())
WHERE last_active_at IS NULL;

ALTER TABLE app.users
  ALTER COLUMN last_active_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN last_active_at SET NOT NULL,
  ADD CONSTRAINT users_timezone_format_chk
    CHECK (char_length(timezone) BETWEEN 1 AND 64),
  ADD CONSTRAINT users_locale_format_chk
    CHECK (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$');

CREATE INDEX users_last_active_idx
  ON app.users (last_active_at DESC, user_id);

CREATE OR REPLACE FUNCTION app.record_current_user_activity()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_status varchar;
  v_inserted boolean := false;
  v_previous_active_at timestamptz;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  INSERT INTO app.users (user_id, status)
  VALUES (v_user_id, 'active')
  ON CONFLICT (user_id) DO NOTHING
  RETURNING true INTO v_inserted;

  SELECT users.status, users.last_active_at
  INTO v_status, v_previous_active_at
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  IF v_inserted THEN
    v_previous_active_at := NULL;
  END IF;

  UPDATE app.users
  SET last_active_at = v_now,
      updated_at = v_now
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'previousActiveAt', v_previous_active_at,
    'now', v_now
  );
END;
$function$;

ALTER FUNCTION app.record_current_user_activity() OWNER TO diet_owner;
REVOKE ALL ON FUNCTION app.record_current_user_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_current_user_activity() TO diet_app, diet_owner;

CREATE OR REPLACE FUNCTION app.update_current_user_timezone(p_timezone varchar)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_timezone varchar := btrim(p_timezone);
  v_status varchar;
  v_saved app.users%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF v_timezone IS NULL
     OR char_length(v_timezone) < 1
     OR char_length(v_timezone) > 64
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_timezone_names AS timezone_name
       WHERE timezone_name.name = v_timezone
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '用户时区格式不正确';
  END IF;

  INSERT INTO app.users (user_id, status)
  VALUES (v_user_id, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT users.status
  INTO v_status
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  UPDATE app.users
  SET timezone = v_timezone,
      updated_at = clock_timestamp()
  WHERE user_id = v_user_id
  RETURNING * INTO v_saved;

  RETURN jsonb_build_object(
    'userId', v_saved.user_id,
    'timezone', v_saved.timezone,
    'locale', v_saved.locale,
    'lastActiveAt', v_saved.last_active_at,
    'createdAt', v_saved.created_at
  );
END;
$function$;

ALTER FUNCTION app.update_current_user_timezone(varchar) OWNER TO diet_owner;
REVOKE ALL ON FUNCTION app.update_current_user_timezone(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.update_current_user_timezone(varchar)
TO diet_app, diet_owner;

COMMENT ON COLUMN app.users.last_active_at IS
  '最近一次由record_current_user_activity确认的业务活跃时间。';
COMMENT ON COLUMN app.users.timezone IS
  '用户IANA时区；写入必须经过update_current_user_timezone验证。';
COMMENT ON COLUMN app.users.locale IS
  '用户界面语言区域标识；004d只建立默认值和读取契约。';
COMMENT ON FUNCTION app.record_current_user_activity() IS
  '原子返回前次活跃时间并写入当前数据库时间。';
COMMENT ON FUNCTION app.update_current_user_timezone(varchar) IS
  '验证IANA时区后更新当前active用户设置，不接受调用方指定user_id。';

COMMIT;

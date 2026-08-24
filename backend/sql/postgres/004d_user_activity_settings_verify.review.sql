-- 004d 云端功能沙箱。所有业务写入均在同一事务中，并最终 ROLLBACK。
-- 固定测试ID仅用于回滚后的零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004d_verify_a', 'acct:004d_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004d固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004d_verify_a', true);
SET LOCAL ROLE diet_app;

DO $assert_activity_and_defaults$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_timezone varchar;
  v_locale varchar;
BEGIN
  v_first := app.record_current_user_activity();
  v_second := app.record_current_user_activity();

  SELECT timezone, locale
  INTO v_timezone, v_locale
  FROM app.users
  WHERE user_id = 'acct:004d_verify_a';

  IF v_first->'previousActiveAt' <> 'null'::jsonb
     OR v_first->>'now' IS NULL
     OR v_second->>'previousActiveAt' IS NULL
     OR (v_second->>'previousActiveAt')::timestamptz
        <> (v_first->>'now')::timestamptz
     OR (v_second->>'now')::timestamptz
        < (v_second->>'previousActiveAt')::timestamptz
     OR v_timezone <> 'Asia/Shanghai'
     OR v_locale <> 'zh-CN' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004d活跃时间或默认设置断言失败';
  END IF;
END
$assert_activity_and_defaults$;

SELECT 'PASS' AS activity_and_default_settings_verified;

DO $assert_timezone_update$
DECLARE
  v_result jsonb;
  v_saved_timezone varchar;
BEGIN
  v_result := app.update_current_user_timezone('UTC');

  SELECT timezone INTO v_saved_timezone
  FROM app.users
  WHERE user_id = 'acct:004d_verify_a';

  IF v_result->>'timezone' <> 'UTC'
     OR v_result->>'locale' <> 'zh-CN'
     OR v_saved_timezone <> 'UTC' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004d时区更新断言失败';
  END IF;
END
$assert_timezone_update$;

SELECT 'PASS' AS timezone_update_verified;

DO $assert_invalid_timezone$
DECLARE
  v_saved_timezone varchar;
BEGIN
  BEGIN
    PERFORM app.update_current_user_timezone('Not/A_Real_Timezone');
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '无效时区未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  SELECT timezone INTO v_saved_timezone
  FROM app.users
  WHERE user_id = 'acct:004d_verify_a';

  IF v_saved_timezone <> 'UTC' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '无效时区路径修改了已保存设置';
  END IF;
END
$assert_invalid_timezone$;

SELECT 'PASS' AS invalid_timezone_rejected;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004d_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_cross_user_isolation$
BEGIN
  IF (SELECT COUNT(*) FROM app.users
      WHERE user_id = 'acct:004d_verify_a') <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004d跨用户隔离失败';
  END IF;
END
$assert_cross_user_isolation$;

SELECT 'PASS' AS cross_user_rls_isolation;

RESET ROLE;
ROLLBACK;

SELECT
  CASE WHEN (
    SELECT COUNT(*) FROM app.users
    WHERE user_id IN ('acct:004d_verify_a', 'acct:004d_verify_b')
  ) = 0
  THEN 'PASS' ELSE 'FAIL' END AS rollback_cleanup_status;

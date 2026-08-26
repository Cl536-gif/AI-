-- REVIEW ONLY: 005k应用回滚到SQLite后，证明PostgreSQL固定测试写入仍被保留。
-- 不输出设备摘要、用户ID、建议正文或其他业务内容；本脚本只读并最终ROLLBACK。

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL ROLE diet_owner;

DO $verify$
DECLARE
  v_device_id constant text := '00580000-0000-4000-8000-000000000001';
  v_hash text;
  v_user_id varchar(128);
  v_identity_count integer;
  v_user_count integer;
  v_advice_count integer;
BEGIN
  v_hash := encode(
    public.digest(
      convert_to('diet-secretary-device:v1:' || v_device_id, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  SELECT count(*)::integer, min(user_id)
  INTO v_identity_count, v_user_id
  FROM app.user_identities
  WHERE identity_type = 'device_sha256'
    AND external_subject_hash = v_hash;

  IF v_identity_count <> 1 OR v_user_id IS NULL OR v_user_id NOT LIKE 'anon:%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '005k应用回滚后固定测试身份没有唯一保留在PostgreSQL';
  END IF;

  SELECT count(*)::integer INTO v_user_count
  FROM app.users
  WHERE user_id = v_user_id;

  SELECT count(*)::integer INTO v_advice_count
  FROM app.user_advice_history
  WHERE user_id = v_user_id
    AND idempotency_key NOT LIKE '005h-marker:%';

  IF v_user_count <> 1 OR v_advice_count < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '005k应用回滚后PostgreSQL固定测试写入不完整';
  END IF;

  PERFORM set_config('app.verify_005k_residue', 'PASS', true);
  PERFORM set_config('app.verify_005k_identity_count', v_identity_count::text, true);
  PERFORM set_config('app.verify_005k_user_count', v_user_count::text, true);
  PERFORM set_config('app.verify_005k_advice_count', v_advice_count::text, true);
END
$verify$;

SELECT
  current_setting('app.verify_005k_residue') AS status,
  current_setting('app.verify_005k_identity_count')::integer = 1
    AS postgres_identity_preserved,
  current_setting('app.verify_005k_user_count')::integer = 1
    AS postgres_user_preserved,
  current_setting('app.verify_005k_advice_count')::integer
    AS postgres_advice_rows_preserved;

ROLLBACK;

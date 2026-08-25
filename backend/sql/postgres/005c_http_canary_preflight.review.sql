-- REVIEW ONLY: 005c真实HTTP灰度前置检查。
-- 只允许固定测试设备，不读取或输出设备摘要、用户ID或业务内容。

BEGIN;
SET LOCAL ROLE diet_owner;

DO $verify$
DECLARE
  v_device_id constant text := '005c0000-0000-4000-8000-000000000001';
  v_hash text;
  v_identity_count integer;
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'users', 'user_identities', 'user_profiles', 'user_menstrual_profiles',
    'profile_revisions', 'menstrual_profile_revisions', 'user_consents',
    'user_events', 'long_term_profile_confirmation_requests',
    'long_term_profile_field_confirmations', 'user_profile_versions',
    'user_profile_version_history', 'user_service_status',
    'user_service_transitions', 'energy_calculations', 'user_plan_versions',
    'plan_state_transitions', 'plan_revision_commands', 'user_notifications',
    'user_advice_history'
  ]
  LOOP
    IF to_regclass('app.' || v_table) IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = '005c清理所需数据库对象不完整';
    END IF;
  END LOOP;

  v_hash := encode(
    public.digest(
      convert_to('diet-secretary-device:v1:' || v_device_id, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  SELECT count(*)::integer
  INTO v_identity_count
  FROM app.user_identities
  WHERE identity_type = 'device_sha256'
    AND external_subject_hash = v_hash;

  IF v_identity_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '005c固定测试身份已存在，禁止在未清理状态下开始HTTP灰度';
  END IF;

  PERFORM set_config('app.verify_005c_preflight', 'PASS', true);
END
$verify$;

SELECT
  current_setting('app.verify_005c_preflight') AS status,
  true AS cleanup_tables_present,
  true AS fixed_test_identity_absent,
  0 AS matching_identity_count;

ROLLBACK;

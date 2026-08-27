-- REVIEW ONLY: 005m副作用恢复云验证后的精确用户数据清理。
-- checkpointer必须先由cleanup-checkpointer阶段清零。
-- 仅按固定测试设备摘要解析出的唯一anon用户清理；不得改为通配删除。

BEGIN;
SET LOCAL ROLE diet_owner;

DO $cleanup$
DECLARE
  v_device_id constant text := '005d0000-0000-4000-8000-000000000001';
  v_hash text;
  v_user_id varchar(128);
  v_identity_count integer;
  v_user_count integer;
  v_advice_count integer;
  v_unique_advice_count integer;
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
      MESSAGE = '005m固定测试身份没有唯一映射到匿名用户，拒绝清理';
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.user_merges
    WHERE source_user_id = v_user_id OR target_user_id = v_user_id
  ) OR EXISTS (
    SELECT 1 FROM app.users WHERE merged_into_user_id = v_user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '005m测试用户参与了身份合并，拒绝自动清理';
  END IF;

  SELECT count(*)::integer INTO v_user_count
  FROM app.users WHERE user_id = v_user_id;
  SELECT count(*)::integer, count(DISTINCT idempotency_key)::integer
  INTO v_advice_count, v_unique_advice_count
  FROM app.user_advice_history WHERE user_id = v_user_id;

  IF v_user_count <> 1 OR v_advice_count < 1 OR v_unique_advice_count <> v_advice_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '005m副作用恢复证据不完整或建议存在重复，拒绝清理';
  END IF;

  DELETE FROM app.long_term_profile_field_confirmations WHERE user_id = v_user_id;
  DELETE FROM app.long_term_profile_confirmation_requests WHERE user_id = v_user_id;
  DELETE FROM app.plan_revision_commands WHERE user_id = v_user_id;
  DELETE FROM app.plan_state_transitions WHERE user_id = v_user_id;
  DELETE FROM app.user_plan_versions WHERE user_id = v_user_id;
  DELETE FROM app.user_notifications WHERE user_id = v_user_id;
  DELETE FROM app.user_advice_history WHERE user_id = v_user_id;
  DELETE FROM app.energy_calculations WHERE user_id = v_user_id;
  DELETE FROM app.user_service_transitions WHERE user_id = v_user_id;
  DELETE FROM app.user_service_status WHERE user_id = v_user_id;
  DELETE FROM app.user_profile_version_history WHERE user_id = v_user_id;
  DELETE FROM app.user_profile_versions WHERE user_id = v_user_id;
  DELETE FROM app.profile_revisions WHERE user_id = v_user_id;
  DELETE FROM app.menstrual_profile_revisions WHERE user_id = v_user_id;
  DELETE FROM app.user_events WHERE user_id = v_user_id;
  DELETE FROM app.user_consents WHERE user_id = v_user_id;
  DELETE FROM app.user_profiles WHERE user_id = v_user_id;
  DELETE FROM app.user_menstrual_profiles WHERE user_id = v_user_id;
  DELETE FROM app.user_identities
  WHERE identity_type = 'device_sha256'
    AND external_subject_hash = v_hash
    AND user_id = v_user_id;
  DELETE FROM app.users WHERE user_id = v_user_id;

  IF EXISTS (
    SELECT 1 FROM app.user_identities
    WHERE identity_type = 'device_sha256'
      AND external_subject_hash = v_hash
  ) OR EXISTS (
    SELECT 1 FROM app.users WHERE user_id = v_user_id
  ) OR EXISTS (
    SELECT 1 FROM app.user_advice_history WHERE user_id = v_user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '005m清理后仍有测试数据残留';
  END IF;

  PERFORM set_config('app.verify_005m_cleanup', 'PASS', true);
  PERFORM set_config('app.verify_005m_advice_before_cleanup', v_advice_count::text, true);
END
$cleanup$;

SELECT
  current_setting('app.verify_005m_cleanup') AS status,
  true AS advice_idempotency_proven,
  current_setting('app.verify_005m_advice_before_cleanup')::integer AS advice_rows_before_cleanup,
  0 AS remaining_identities,
  0 AS remaining_users,
  0 AS remaining_advice;

COMMIT;

-- 004c 云端功能沙箱。所有业务数据写入都在同一事务中并最终 ROLLBACK。
-- 固定测试ID仅用于回滚后的零残留证明，不读取或输出任何真实用户数据。

BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004c_verify_a', 'acct:004c_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004c固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004c_verify_a', true);
SET LOCAL ROLE diet_app;

-- 版本1：首次保存普通档案。
SELECT app.save_current_user_profile_versioned(
  '{
    "schemaVersion": 1,
    "body": {
      "equationSex": "female",
      "ageYears": 28,
      "heightCm": 165,
      "currentWeightKg": 60,
      "targetWeightKg": 56,
      "dailyActivity": "久坐",
      "recentWeightChange": null
    },
    "diet": {
      "scene": "mixed",
      "cafeteriaMode": "mixed",
      "budgetCnyPerMeal": 30,
      "tastePreferences": ["清淡"],
      "restrictions": [],
      "goals": ["稳定减脂"],
      "exerciseBaseline": "每周步行三次"
    }
  }'::jsonb,
  'user',
  0,
  '["body", "diet"]'::jsonb
) AS version_1_result;

-- 版本2：基于expectedVersion=1更新普通档案。
SELECT app.save_current_user_profile_versioned(
  '{
    "schemaVersion": 1,
    "body": {
      "equationSex": "female",
      "ageYears": 28,
      "heightCm": 165,
      "currentWeightKg": 59.5,
      "targetWeightKg": 56,
      "dailyActivity": "久坐",
      "recentWeightChange": "下降0.5kg"
    },
    "diet": {
      "scene": "mixed",
      "cafeteriaMode": "mixed",
      "budgetCnyPerMeal": 30,
      "tastePreferences": ["清淡"],
      "restrictions": [],
      "goals": ["稳定减脂"],
      "exerciseBaseline": "每周步行三次"
    }
  }'::jsonb,
  'user',
  1,
  '["body"]'::jsonb
) AS version_2_result;

-- 经期档案写入前先追加有效授权。
SELECT app.record_current_user_consent(
  '{
    "consentType": "menstrual_tracking",
    "status": "granted",
    "recordedAt": "2026-08-24T12:10:00+08:00",
    "source": "user"
  }'::jsonb
) AS menstrual_consent_result;

-- 版本3：只写经期分表，统一版本仍只增加一次。
SELECT app.save_current_user_profile_versioned(
  '{
    "schemaVersion": 1,
    "body": {
      "equationSex": "female",
      "ageYears": 28,
      "heightCm": 165,
      "currentWeightKg": 59.5,
      "targetWeightKg": 56,
      "dailyActivity": "久坐",
      "recentWeightChange": "下降0.5kg"
    },
    "diet": {
      "scene": "mixed",
      "cafeteriaMode": "mixed",
      "budgetCnyPerMeal": 30,
      "tastePreferences": ["清淡"],
      "restrictions": [],
      "goals": ["稳定减脂"],
      "exerciseBaseline": "每周步行三次"
    },
    "menstrualTracking": {
      "applicability": "applicable",
      "status": "active"
    }
  }'::jsonb,
  'user',
  2,
  '["menstrualTracking"]'::jsonb
) AS version_3_result;

-- 账本、普通修订和敏感修订必须严格对应3个统一版本。
DO $assert_versions$
DECLARE
  v_current integer;
  v_history integer;
  v_normal integer;
  v_menstrual integer;
  v_sensitive_ref_only boolean;
BEGIN
  SELECT current_version INTO v_current
  FROM app.user_profile_versions
  WHERE user_id = 'acct:004c_verify_a';

  SELECT COUNT(*) INTO v_history
  FROM app.user_profile_version_history
  WHERE user_id = 'acct:004c_verify_a';

  SELECT COUNT(*) INTO v_normal
  FROM app.profile_revisions
  WHERE user_id = 'acct:004c_verify_a';

  SELECT COUNT(*) INTO v_menstrual
  FROM app.menstrual_profile_revisions
  WHERE user_id = 'acct:004c_verify_a';

  SELECT
    normal_revision_id IS NULL
      AND menstrual_revision_id IS NOT NULL
      AND changed_fields = '["menstrualTracking"]'::jsonb
  INTO v_sensitive_ref_only
  FROM app.user_profile_version_history
  WHERE user_id = 'acct:004c_verify_a'
    AND profile_version = 3;

  IF v_current <> 3
     OR v_history <> 3
     OR v_normal <> 2
     OR v_menstrual <> 1
     OR v_sensitive_ref_only IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004c版本账本断言失败';
  END IF;
END
$assert_versions$;

SELECT 'PASS' AS version_ledger_and_sensitive_split;

-- expectedVersion=2已经过期，必须精确返回40001且不产生版本4。
DO $assert_conflict$
BEGIN
  BEGIN
    PERFORM app.save_current_user_profile_versioned(
      '{
        "schemaVersion": 1,
        "body": {},
        "diet": {}
      }'::jsonb,
      'user',
      2,
      '["body"]'::jsonb
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '过期expectedVersion未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '40001' THEN NULL;
  END;

  IF (SELECT current_version FROM app.user_profile_versions
      WHERE user_id = 'acct:004c_verify_a') <> 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '冲突路径错误增加版本';
  END IF;
END
$assert_conflict$;

SELECT 'PASS' AS stale_expected_version_rejected;

-- 切换到用户B后，RLS必须完全隐藏用户A的版本与快照。
RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004c_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_isolation$
BEGIN
  IF (SELECT COUNT(*) FROM app.user_profile_versions
      WHERE user_id = 'acct:004c_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.user_profile_version_history
         WHERE user_id = 'acct:004c_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.user_profiles
         WHERE user_id = 'acct:004c_verify_a') <> 0
     OR (SELECT COUNT(*) FROM app.user_menstrual_profiles
         WHERE user_id = 'acct:004c_verify_a') <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '004c跨用户隔离失败';
  END IF;
END
$assert_isolation$;

SELECT 'PASS' AS cross_user_rls_isolation;

RESET ROLE;
ROLLBACK;

-- 回滚后以管理身份只核对固定测试ID的残留计数，不输出任何数据内容。
SELECT
  CASE WHEN
    (SELECT COUNT(*) FROM app.users
      WHERE user_id IN ('acct:004c_verify_a', 'acct:004c_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.user_profiles
      WHERE user_id = 'acct:004c_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.user_menstrual_profiles
      WHERE user_id = 'acct:004c_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.profile_revisions
      WHERE user_id = 'acct:004c_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.menstrual_profile_revisions
      WHERE user_id = 'acct:004c_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.user_consents
      WHERE user_id = 'acct:004c_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.user_profile_versions
      WHERE user_id = 'acct:004c_verify_a') = 0
    AND (SELECT COUNT(*) FROM app.user_profile_version_history
      WHERE user_id = 'acct:004c_verify_a') = 0
  THEN 'PASS' ELSE 'FAIL' END AS rollback_cleanup_status;

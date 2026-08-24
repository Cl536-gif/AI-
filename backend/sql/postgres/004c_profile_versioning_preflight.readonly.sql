-- 004c 云端只读前置检查。可在腾讯云 DMC 的 diet_secretary 数据库执行。
-- 只返回对象状态和计数，不返回用户ID、档案内容或连接信息。

BEGIN;
SET TRANSACTION READ ONLY;

WITH checks AS (
  SELECT
    current_database() = 'diet_secretary' AS database_matched,
    to_regclass('app.users') IS NOT NULL
      AND to_regclass('app.user_profiles') IS NOT NULL
      AND to_regclass('app.profile_revisions') IS NOT NULL
      AND to_regclass('app.user_menstrual_profiles') IS NOT NULL
      AND to_regclass('app.menstrual_profile_revisions') IS NOT NULL
      AS required_tables_present,
    to_regprocedure('app.current_user_id()') IS NOT NULL
      AND to_regprocedure(
        'app.save_current_user_profile(jsonb,character varying)'
      ) IS NOT NULL
      AND to_regprocedure(
        'app.save_current_user_menstrual_profile(jsonb,character varying)'
      ) IS NOT NULL
      AS required_functions_present,
    to_regclass('app.user_profile_versions') IS NULL
      AND to_regclass('app.user_profile_version_history') IS NULL
      AND to_regprocedure(
        'app.save_current_user_profile_versioned(jsonb,character varying,integer,jsonb)'
      ) IS NULL
      AND to_regprocedure(
        'app.save_current_user_profile_legacy_004c(jsonb,character varying)'
      ) IS NULL
      AS migration_targets_absent,
    has_function_privilege(
      'diet_app',
      'app.save_current_user_profile(jsonb,character varying)',
      'EXECUTE'
    ) AS diet_app_can_save_normal_profile,
    has_function_privilege(
      'diet_app',
      'app.save_current_user_menstrual_profile(jsonb,character varying)',
      'EXECUTE'
    ) AS diet_app_can_save_menstrual_profile,
    NOT has_function_privilege(
      'public',
      'app.save_current_user_profile(jsonb,character varying)',
      'EXECUTE'
    ) AS public_cannot_save_normal_profile,
    NOT has_function_privilege(
      'public',
      'app.save_current_user_menstrual_profile(jsonb,character varying)',
      'EXECUTE'
    ) AS public_cannot_save_menstrual_profile,
    (
      SELECT COUNT(*)
      FROM app.user_profiles AS profile
      WHERE NOT EXISTS (
        SELECT 1
        FROM app.profile_revisions AS revision
        WHERE revision.user_id = profile.user_id
      )
    ) AS normal_profiles_without_history,
    (
      SELECT COUNT(*)
      FROM app.user_menstrual_profiles AS profile
      WHERE NOT EXISTS (
        SELECT 1
        FROM app.menstrual_profile_revisions AS revision
        WHERE revision.user_id = profile.user_id
      )
    ) AS menstrual_profiles_without_history,
    (
      SELECT COUNT(*)
      FROM app.profile_revisions AS revision
      WHERE revision.source NOT IN (
        'user', 'secretary', 'device', 'import', 'system'
      )
    ) AS normal_revisions_with_unknown_source,
    (
      SELECT COUNT(*)
      FROM app.menstrual_profile_revisions AS revision
      WHERE revision.source NOT IN ('user', 'secretary', 'system')
    ) AS menstrual_revisions_with_unknown_source,
    (SELECT COUNT(*) FROM app.profile_revisions) AS normal_revision_count,
    (SELECT COUNT(*) FROM app.menstrual_profile_revisions)
      AS menstrual_revision_count
)
SELECT
  CASE
    WHEN database_matched
      AND required_tables_present
      AND required_functions_present
      AND migration_targets_absent
      AND diet_app_can_save_normal_profile
      AND diet_app_can_save_menstrual_profile
      AND public_cannot_save_normal_profile
      AND public_cannot_save_menstrual_profile
      AND normal_profiles_without_history = 0
      AND menstrual_profiles_without_history = 0
      AND normal_revisions_with_unknown_source = 0
      AND menstrual_revisions_with_unknown_source = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  database_matched,
  required_tables_present,
  required_functions_present,
  migration_targets_absent,
  diet_app_can_save_normal_profile,
  diet_app_can_save_menstrual_profile,
  public_cannot_save_normal_profile,
  public_cannot_save_menstrual_profile,
  normal_profiles_without_history,
  menstrual_profiles_without_history,
  normal_revisions_with_unknown_source,
  menstrual_revisions_with_unknown_source,
  normal_revision_count,
  menstrual_revision_count
FROM checks;

ROLLBACK;


-- 004c 部署后只读对象核验；不返回用户数据或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH table_checks AS (
  SELECT
    COUNT(*) = 2 AS tables_valid
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname IN (
      'user_profile_versions',
      'user_profile_version_history'
    )
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), policy_checks AS (
  SELECT COUNT(*) = 2 AS policies_valid
  FROM pg_policies
  WHERE schemaname = 'app'
    AND policyname IN (
      'user_profile_versions_select_own',
      'user_profile_version_history_select_own'
    )
    AND cmd = 'SELECT'
    AND roles = ARRAY['diet_app']::name[]
), function_checks AS (
  SELECT
    to_regprocedure(
      'app.save_current_user_profile_versioned(jsonb,character varying,integer,jsonb)'
    ) IS NOT NULL AS versioned_function_present,
    to_regprocedure(
      'app.save_current_user_profile_legacy_004c(jsonb,character varying)'
    ) IS NOT NULL AS private_legacy_present,
    to_regprocedure(
      'app.save_current_user_profile(jsonb,character varying)'
    ) IS NOT NULL AS compatibility_function_present,
    has_function_privilege(
      'diet_app',
      'app.save_current_user_profile_versioned(jsonb,character varying,integer,jsonb)',
      'EXECUTE'
    ) AS diet_app_can_execute_versioned,
    NOT has_function_privilege(
      'public',
      'app.save_current_user_profile_versioned(jsonb,character varying,integer,jsonb)',
      'EXECUTE'
    ) AS public_cannot_execute_versioned,
    NOT has_function_privilege(
      'diet_app',
      'app.save_current_user_profile_legacy_004c(jsonb,character varying)',
      'EXECUTE'
    ) AS diet_app_cannot_execute_legacy,
    NOT has_function_privilege(
      'public',
      'app.save_current_user_profile_legacy_004c(jsonb,character varying)',
      'EXECUTE'
    ) AS public_cannot_execute_legacy
), owner_checks AS (
  SELECT COUNT(*) = 3 AS functions_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname IN (
      'save_current_user_profile_versioned',
      'save_current_user_profile_legacy_004c',
      'save_current_user_profile'
    )
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
), row_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.user_profile_versions) AS version_row_count,
    (SELECT COUNT(*) FROM app.user_profile_version_history) AS history_row_count
)
SELECT
  CASE
    WHEN tables_valid
      AND policies_valid
      AND versioned_function_present
      AND private_legacy_present
      AND compatibility_function_present
      AND diet_app_can_execute_versioned
      AND public_cannot_execute_versioned
      AND diet_app_cannot_execute_legacy
      AND public_cannot_execute_legacy
      AND functions_owned_and_secured
      AND version_row_count = 0
      AND history_row_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS postflight_status,
  table_checks.*,
  policy_checks.*,
  function_checks.*,
  owner_checks.*,
  row_checks.*
FROM table_checks, policy_checks, function_checks, owner_checks, row_checks;

ROLLBACK;


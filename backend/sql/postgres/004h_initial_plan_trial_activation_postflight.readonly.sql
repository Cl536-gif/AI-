-- 004h 部署后只读对象核验；不返回用户ID、计划内容或连接信息。
BEGIN;
SET TRANSACTION READ ONLY;

WITH function_target AS (
  SELECT to_regprocedure(
    'app.activate_current_user_initial_plan_and_trial(character varying,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
  ) AS function_oid
), function_checks AS (
  SELECT
    function_oid IS NOT NULL AS activation_function_present,
    COALESCE(
      has_function_privilege('diet_app', function_oid, 'EXECUTE'),
      false
    ) AS diet_app_can_execute_function,
    COALESCE(
      NOT has_function_privilege('public', function_oid, 'EXECUTE'),
      false
    ) AS public_cannot_execute_function
  FROM function_target
), owner_checks AS (
  SELECT COUNT(*) = 1 AS function_owned_and_secured
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname = 'activate_current_user_initial_plan_and_trial'
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
    AND procedure.provolatile = 'v'
    AND procedure.proconfig @> ARRAY['search_path=pg_catalog, app']::text[]
), definition_checks AS (
  SELECT COUNT(*) = 1 AS atomic_definition_valid
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'app'
    AND procedure.proname = 'activate_current_user_initial_plan_and_trial'
    AND procedure.prosrc LIKE '%FOR UPDATE%'
    AND procedure.prosrc LIKE '%official_plan_delivered%'
    AND procedure.prosrc LIKE '%first_official_plan_delivered%'
    AND procedure.prosrc LIKE '%336 hours%'
    AND procedure.prosrc LIKE '%312 hours%'
), row_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.users) AS user_row_count,
    (SELECT COUNT(*) FROM app.user_service_status) AS service_status_row_count,
    (SELECT COUNT(*) FROM app.user_plan_versions) AS plan_row_count,
    (
      SELECT COUNT(*)
      FROM app.user_plan_versions AS plan
      LEFT JOIN app.user_service_status AS service
        ON service.user_id = plan.user_id
      WHERE (
        plan.status = 'active'
        AND service.status = 'profile_confirmed'
      ) OR (
        plan.status = 'draft'
        AND service.status = 'trial_active'
        AND service.official_plan_id = plan.plan_id
      )
    ) AS inconsistent_initial_activation_count
)
SELECT
  CASE
    WHEN activation_function_present
      AND diet_app_can_execute_function
      AND public_cannot_execute_function
      AND function_owned_and_secured
      AND atomic_definition_valid
      AND inconsistent_initial_activation_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS postflight_status,
  function_checks.*,
  owner_checks.*,
  definition_checks.*,
  row_checks.*
FROM function_checks, owner_checks, definition_checks, row_checks;

ROLLBACK;

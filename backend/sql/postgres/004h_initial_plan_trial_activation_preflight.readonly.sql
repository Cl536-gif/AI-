-- 004h 云端只读前置检查。只返回对象状态和计数，不返回用户或计划数据。
BEGIN;
SET TRANSACTION READ ONLY;

WITH prerequisite_tables AS (
  SELECT COUNT(*) = 5 AS prerequisite_tables_valid
  FROM pg_class AS class
  JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = class.relowner
  WHERE namespace.nspname = 'app'
    AND class.relname IN (
      'users',
      'user_service_status',
      'user_service_transitions',
      'user_plan_versions',
      'plan_state_transitions'
    )
    AND class.relkind = 'r'
    AND owner_role.rolname = 'diet_owner'
    AND class.relrowsecurity
), prerequisite_functions AS (
  SELECT COUNT(*) = 3 AS prerequisite_functions_valid
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_roles AS owner_role ON owner_role.oid = procedure.proowner
  WHERE namespace.nspname = 'app'
    AND procedure.proname IN (
      'set_current_user_service_status',
      'create_current_user_plan_draft',
      'transition_current_user_plan'
    )
    AND owner_role.rolname = 'diet_owner'
    AND procedure.prosecdef
), target_object AS (
  SELECT to_regprocedure(
    'app.activate_current_user_initial_plan_and_trial(character varying,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
  ) IS NULL AS activation_function_absent
), data_checks AS (
  SELECT
    (SELECT COUNT(*) FROM app.users) AS existing_user_count,
    (SELECT COUNT(*) FROM app.user_service_status) AS existing_service_status_count,
    (SELECT COUNT(*) FROM app.user_plan_versions) AS existing_plan_count,
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
    WHEN current_database() = 'diet_secretary'
      AND prerequisite_tables_valid
      AND prerequisite_functions_valid
      AND activation_function_absent
      AND inconsistent_initial_activation_count = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS preflight_status,
  current_database() = 'diet_secretary' AS database_matched,
  prerequisite_tables.*,
  prerequisite_functions.*,
  target_object.*,
  data_checks.*
FROM prerequisite_tables, prerequisite_functions, target_object, data_checks;

ROLLBACK;

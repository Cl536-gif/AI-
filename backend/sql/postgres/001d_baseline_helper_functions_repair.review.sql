-- 001d: 修复拆分版 001 基线遗漏的两个 RLS 辅助函数。
-- 目标数据库：diet_secretary
-- 执行身份：admin_rag2（必须已被授予 diet_owner）
-- 本脚本不创建 current_user_is_active()；该函数仍由 002b 创建。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS character varying
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::character varying;
$function$;

CREATE OR REPLACE FUNCTION app.current_user_has_consent(
  p_consent_type character varying
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.user_consents AS consent
    WHERE consent.user_id = app.current_user_id()
      AND consent.consent_type = p_consent_type
      AND consent.status = 'granted'
  );
$function$;

ALTER FUNCTION app.current_user_id() OWNER TO diet_owner;
ALTER FUNCTION app.current_user_has_consent(character varying) OWNER TO diet_owner;

REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_user_has_consent(character varying) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.current_user_id() TO diet_app;
GRANT EXECUTE ON FUNCTION app.current_user_has_consent(character varying) TO diet_app;

COMMIT;

SELECT
  to_regprocedure('app.current_user_id()') IS NOT NULL AS current_user_id_exists,
  to_regprocedure('app.current_user_has_consent(character varying)') IS NOT NULL
    AS current_user_has_consent_exists,
  pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer,
  has_function_privilege('diet_app', p.oid, 'EXECUTE') AS diet_app_execute,
  has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
FROM pg_proc AS p
JOIN pg_namespace AS n
  ON n.oid = p.pronamespace
WHERE n.nspname = 'app'
  AND p.proname = 'current_user_has_consent';

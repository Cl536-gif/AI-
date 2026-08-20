-- 001b: 最小权限与行级安全（RLS）
-- 前置：001a_user_data_core.sql 已成功提交。
-- 每个业务事务必须先执行：SET LOCAL app.user_id = '<当前用户ID>';

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.current_app_user_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app.has_current_consent(
  requested_user_id text,
  requested_consent_type text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT COALESCE((
    SELECT c.status = 'granted'
    FROM app.user_consents AS c
    WHERE c.user_id = requested_user_id
      AND c.consent_type = requested_consent_type
    ORDER BY c.recorded_at DESC, c.consent_id DESC
    LIMIT 1
  ), false)
$$;

REVOKE ALL ON FUNCTION app.current_app_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.has_current_consent(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_app_user_id() TO diet_app;
GRANT EXECUTE ON FUNCTION app.has_current_consent(text, text) TO diet_app;

GRANT SELECT, INSERT ON app.users TO diet_app;
GRANT SELECT, INSERT, UPDATE ON app.user_profiles TO diet_app;
GRANT SELECT, INSERT, UPDATE ON app.user_menstrual_profiles TO diet_app;
GRANT SELECT, INSERT ON app.profile_revisions TO diet_app;
GRANT SELECT, INSERT ON app.menstrual_profile_revisions TO diet_app;
GRANT SELECT, INSERT ON app.user_consents TO diet_app;
GRANT SELECT, INSERT ON app.user_events TO diet_app;

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_menstrual_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_menstrual_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.profile_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.menstrual_profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.menstrual_profile_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_events FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select_own ON app.users
  FOR SELECT TO diet_app
  USING (user_id = app.current_app_user_id());
CREATE POLICY users_insert_own ON app.users
  FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_app_user_id() AND status = 'active' AND merged_into_user_id IS NULL);

CREATE POLICY profiles_select_own ON app.user_profiles
  FOR SELECT TO diet_app
  USING (user_id = app.current_app_user_id());
CREATE POLICY profiles_insert_own ON app.user_profiles
  FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_app_user_id());
CREATE POLICY profiles_update_own ON app.user_profiles
  FOR UPDATE TO diet_app
  USING (user_id = app.current_app_user_id())
  WITH CHECK (user_id = app.current_app_user_id());

CREATE POLICY profile_revisions_select_own ON app.profile_revisions
  FOR SELECT TO diet_app
  USING (user_id = app.current_app_user_id());
CREATE POLICY profile_revisions_insert_own ON app.profile_revisions
  FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_app_user_id());

CREATE POLICY consents_select_own ON app.user_consents
  FOR SELECT TO diet_app
  USING (user_id = app.current_app_user_id());
CREATE POLICY consents_insert_own ON app.user_consents
  FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_app_user_id());

-- 经期当前档案：必须属于当前用户，且当前最新授权为 granted。
CREATE POLICY menstrual_profiles_select_authorized ON app.user_menstrual_profiles
  FOR SELECT TO diet_app
  USING (
    user_id = app.current_app_user_id()
    AND app.has_current_consent(user_id, 'menstrual_tracking')
  );
CREATE POLICY menstrual_profiles_insert_authorized ON app.user_menstrual_profiles
  FOR INSERT TO diet_app
  WITH CHECK (
    user_id = app.current_app_user_id()
    AND app.has_current_consent(user_id, 'menstrual_tracking')
  );
CREATE POLICY menstrual_profiles_update_authorized ON app.user_menstrual_profiles
  FOR UPDATE TO diet_app
  USING (
    user_id = app.current_app_user_id()
    AND app.has_current_consent(user_id, 'menstrual_tracking')
  )
  WITH CHECK (
    user_id = app.current_app_user_id()
    AND app.has_current_consent(user_id, 'menstrual_tracking')
  );

-- 经期历史允许在重新授权后恢复；撤回期间不可读取、不可新增。
CREATE POLICY menstrual_revisions_select_authorized ON app.menstrual_profile_revisions
  FOR SELECT TO diet_app
  USING (
    user_id = app.current_app_user_id()
    AND app.has_current_consent(user_id, 'menstrual_tracking')
  );
CREATE POLICY menstrual_revisions_insert_authorized ON app.menstrual_profile_revisions
  FOR INSERT TO diet_app
  WITH CHECK (
    user_id = app.current_app_user_id()
    AND app.has_current_consent(user_id, 'menstrual_tracking')
  );

CREATE POLICY events_select_own_or_sensitive_authorized ON app.user_events
  FOR SELECT TO diet_app
  USING (
    user_id = app.current_app_user_id()
    AND (
      event_type NOT IN ('menstrual_period_start', 'menstrual_symptom')
      OR app.has_current_consent(user_id, 'menstrual_tracking')
    )
  );
CREATE POLICY events_insert_own_or_sensitive_authorized ON app.user_events
  FOR INSERT TO diet_app
  WITH CHECK (
    user_id = app.current_app_user_id()
    AND (
      event_type NOT IN ('menstrual_period_start', 'menstrual_symptom')
      OR app.has_current_consent(user_id, 'menstrual_tracking')
    )
  );

COMMIT;

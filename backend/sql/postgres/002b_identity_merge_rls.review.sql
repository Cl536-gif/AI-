-- REVIEW ONLY: 002 身份合并批次的权限、RLS 与合并后写入锁定。
-- 前置：002a 已在同一受控迁移批次中成功提交。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.current_user_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT COALESCE(
    (
      SELECT u.status = 'active'
      FROM app.users AS u
      WHERE u.user_id = app.current_user_id()
    ),
    false
  );
$function$;

ALTER FUNCTION app.current_user_is_active()
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.current_user_is_active()
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app.current_user_is_active()
TO diet_app, diet_owner;

-- SECURITY DEFINER RPC 也不得向 merged/disabled 用户写入业务表。
CREATE OR REPLACE FUNCTION app.enforce_active_user_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  -- 与身份合并对 users 行取得的 FOR UPDATE 互斥：业务写入要么先完成并
  -- 被合并读取，要么等待合并提交后看到 merged 状态并被拒绝。
  PERFORM 1
  FROM app.users AS u
  WHERE u.user_id = NEW.user_id
    AND u.status = 'active'
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '目标用户不是 active 状态，禁止写入';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION app.enforce_active_user_write()
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.enforce_active_user_write()
FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.enforce_consumed_profile_confirmation_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.long_term_profile_confirmation_requests AS request
    WHERE request.request_id = NEW.confirmation_request_id
      AND request.user_id = NEW.user_id
      AND request.onboarding_session_id = NEW.onboarding_session_id
      AND request.status = 'consumed'
      AND request.responded_at = NEW.confirmed_at
      AND request.presented_fields ? NEW.field_path
      AND request.presented_fields -> NEW.field_path = NEW.confirmed_value
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '字段确认事实必须与已消费请求的用户、会话、回应时间、展示字段和展示值完全一致';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION app.enforce_consumed_profile_confirmation_request()
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.enforce_consumed_profile_confirmation_request()
FROM PUBLIC;

-- 确认请求必须先以 pending 创建，且只能单向解决一次。
-- 审计身份、展示内容和提问事实创建后均不可改写。
CREATE OR REPLACE FUNCTION app.enforce_profile_confirmation_request_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '长期建档确认请求是审计记录，不允许删除';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = '长期建档确认请求必须以 pending 状态创建';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.request_id IS DISTINCT FROM NEW.request_id
     OR OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.onboarding_session_id IS DISTINCT FROM NEW.onboarding_session_id
     OR OLD.prompt_turn_id IS DISTINCT FROM NEW.prompt_turn_id
     OR OLD.presented_fields IS DISTINCT FROM NEW.presented_fields
     OR OLD.prompted_at IS DISTINCT FROM NEW.prompted_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '确认请求的用户、会话、提问轮次、展示值和创建事实不可改写';
  END IF;

  IF OLD.status <> 'pending'
     OR NEW.status NOT IN ('consumed', 'cancelled') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '确认请求只能从 pending 单向变更为 consumed 或 cancelled';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION app.enforce_profile_confirmation_request_transition()
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.enforce_profile_confirmation_request_transition()
FROM PUBLIC;

-- 字段确认是追加式事实；写入后不得改写或删除。
CREATE OR REPLACE FUNCTION app.enforce_append_only_profile_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = '长期建档字段确认事实只允许追加，不允许更新或删除';
  RETURN NULL;
END;
$function$;

ALTER FUNCTION app.enforce_append_only_profile_confirmation()
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.enforce_append_only_profile_confirmation()
FROM PUBLIC;

DROP TRIGGER IF EXISTS user_profiles_require_active_user
ON app.user_profiles;
CREATE TRIGGER user_profiles_require_active_user
BEFORE INSERT OR UPDATE ON app.user_profiles
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

DROP TRIGGER IF EXISTS menstrual_profiles_require_active_user
ON app.user_menstrual_profiles;
CREATE TRIGGER menstrual_profiles_require_active_user
BEFORE INSERT OR UPDATE ON app.user_menstrual_profiles
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

DROP TRIGGER IF EXISTS profile_revisions_require_active_user
ON app.profile_revisions;
CREATE TRIGGER profile_revisions_require_active_user
BEFORE INSERT OR UPDATE ON app.profile_revisions
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

DROP TRIGGER IF EXISTS long_term_profile_confirmations_require_active_user
ON app.long_term_profile_field_confirmations;
CREATE TRIGGER long_term_profile_confirmations_require_active_user
BEFORE INSERT OR UPDATE ON app.long_term_profile_field_confirmations
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

DROP TRIGGER IF EXISTS long_term_profile_requests_require_active_user
ON app.long_term_profile_confirmation_requests;
CREATE TRIGGER long_term_profile_requests_require_active_user
BEFORE INSERT OR UPDATE ON app.long_term_profile_confirmation_requests
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

DROP TRIGGER IF EXISTS long_term_profile_requests_enforce_transition
ON app.long_term_profile_confirmation_requests;
CREATE TRIGGER long_term_profile_requests_enforce_transition
BEFORE INSERT OR UPDATE OR DELETE ON app.long_term_profile_confirmation_requests
FOR EACH ROW EXECUTE FUNCTION app.enforce_profile_confirmation_request_transition();

DROP TRIGGER IF EXISTS long_term_profile_confirmations_require_consumed_request
ON app.long_term_profile_field_confirmations;
CREATE TRIGGER long_term_profile_confirmations_require_consumed_request
BEFORE INSERT OR UPDATE ON app.long_term_profile_field_confirmations
FOR EACH ROW EXECUTE FUNCTION app.enforce_consumed_profile_confirmation_request();

DROP TRIGGER IF EXISTS long_term_profile_confirmations_append_only
ON app.long_term_profile_field_confirmations;
CREATE TRIGGER long_term_profile_confirmations_append_only
BEFORE UPDATE OR DELETE ON app.long_term_profile_field_confirmations
FOR EACH ROW EXECUTE FUNCTION app.enforce_append_only_profile_confirmation();

DROP TRIGGER IF EXISTS menstrual_revisions_require_active_user
ON app.menstrual_profile_revisions;
CREATE TRIGGER menstrual_revisions_require_active_user
BEFORE INSERT OR UPDATE ON app.menstrual_profile_revisions
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

DROP TRIGGER IF EXISTS user_consents_require_active_user
ON app.user_consents;
CREATE TRIGGER user_consents_require_active_user
BEFORE INSERT OR UPDATE ON app.user_consents
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

DROP TRIGGER IF EXISTS user_events_require_active_user
ON app.user_events;
CREATE TRIGGER user_events_require_active_user
BEFORE INSERT OR UPDATE ON app.user_events
FOR EACH ROW EXECUTE FUNCTION app.enforce_active_user_write();

-- 合并与审计底表默认拒绝，diet_app 只能通过 RPC 访问。
REVOKE ALL ON TABLE app.user_identities FROM PUBLIC, diet_app;
REVOKE ALL ON TABLE app.user_merges FROM PUBLIC, diet_app;
REVOKE ALL ON TABLE app.long_term_profile_confirmation_requests FROM PUBLIC, diet_app;
REVOKE ALL ON TABLE app.long_term_profile_field_confirmations FROM PUBLIC, diet_app;
REVOKE ALL ON TABLE app.profile_merge_conflicts FROM PUBLIC, diet_app;
REVOKE ALL ON TABLE app.event_merge_audit FROM PUBLIC, diet_app;

ALTER TABLE app.user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.long_term_profile_confirmation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.long_term_profile_field_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.profile_merge_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.event_merge_audit ENABLE ROW LEVEL SECURITY;

-- 跨用户合并由表所有者承载的 SECURITY DEFINER RPC 完成。
-- 显式清理历史脚本可能留下的 FORCE RLS；diet_app 仍然受下方策略约束。
ALTER TABLE app.users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_profiles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_menstrual_profiles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.profile_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.menstrual_profile_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_consents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_identities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_merges NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.long_term_profile_confirmation_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.long_term_profile_field_confirmations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.profile_merge_conflicts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.event_merge_audit NO FORCE ROW LEVEL SECURITY;

-- 旧游客身份被标记 merged 后，不再能直接读写业务数据。
-- 同时清理 001 历史审核稿出现过的策略名；多条 permissive
-- 策略会按 OR 合并，遗留任何旧策略都可能绕过 active 限制。
DROP POLICY IF EXISTS users_select_own ON app.users;
DROP POLICY IF EXISTS users_insert_own_active ON app.users;
DROP POLICY IF EXISTS users_insert_own ON app.users;
DROP POLICY IF EXISTS users_self_select ON app.users;
DROP POLICY IF EXISTS users_self_insert ON app.users;
DROP POLICY IF EXISTS users_self_update ON app.users;
CREATE POLICY users_select_own
ON app.users FOR SELECT TO diet_app
USING (
  user_id = app.current_user_id()
  AND status = 'active'
);
CREATE POLICY users_insert_own_active
ON app.users FOR INSERT TO diet_app
WITH CHECK (
  user_id = app.current_user_id()
  AND status = 'active'
  AND merged_into_user_id IS NULL
);

DROP POLICY IF EXISTS user_profiles_select_own ON app.user_profiles;
DROP POLICY IF EXISTS user_profiles_insert_own ON app.user_profiles;
DROP POLICY IF EXISTS user_profiles_update_own ON app.user_profiles;
DROP POLICY IF EXISTS profiles_select_own ON app.user_profiles;
DROP POLICY IF EXISTS profiles_insert_own ON app.user_profiles;
DROP POLICY IF EXISTS profiles_update_own ON app.user_profiles;
DROP POLICY IF EXISTS profiles_self_select ON app.user_profiles;
DROP POLICY IF EXISTS profiles_self_insert ON app.user_profiles;
DROP POLICY IF EXISTS profiles_self_update ON app.user_profiles;
CREATE POLICY user_profiles_select_own
ON app.user_profiles FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());
CREATE POLICY user_profiles_insert_own
ON app.user_profiles FOR INSERT TO diet_app
WITH CHECK (user_id = app.current_user_id() AND app.current_user_is_active());
CREATE POLICY user_profiles_update_own
ON app.user_profiles FOR UPDATE TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active())
WITH CHECK (user_id = app.current_user_id() AND app.current_user_is_active());

DROP POLICY IF EXISTS profile_revisions_select_own ON app.profile_revisions;
DROP POLICY IF EXISTS profile_revisions_insert_own ON app.profile_revisions;
DROP POLICY IF EXISTS profile_revisions_self_select ON app.profile_revisions;
DROP POLICY IF EXISTS profile_revisions_self_insert ON app.profile_revisions;
CREATE POLICY profile_revisions_select_own
ON app.profile_revisions FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());
CREATE POLICY profile_revisions_insert_own
ON app.profile_revisions FOR INSERT TO diet_app
WITH CHECK (user_id = app.current_user_id() AND app.current_user_is_active());

DROP POLICY IF EXISTS user_menstrual_profiles_select_own_consented
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS user_menstrual_profiles_insert_own_consented
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS user_menstrual_profiles_update_own_consented
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS menstrual_profiles_select_authorized
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS menstrual_profiles_insert_authorized
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS menstrual_profiles_update_authorized
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS menstrual_profiles_granted_select
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS menstrual_profiles_granted_insert
ON app.user_menstrual_profiles;
DROP POLICY IF EXISTS menstrual_profiles_granted_update
ON app.user_menstrual_profiles;
CREATE POLICY user_menstrual_profiles_select_own_consented
ON app.user_menstrual_profiles FOR SELECT TO diet_app
USING (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND app.current_user_has_consent('menstrual_tracking')
);
CREATE POLICY user_menstrual_profiles_insert_own_consented
ON app.user_menstrual_profiles FOR INSERT TO diet_app
WITH CHECK (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND app.current_user_has_consent('menstrual_tracking')
);
CREATE POLICY user_menstrual_profiles_update_own_consented
ON app.user_menstrual_profiles FOR UPDATE TO diet_app
USING (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND app.current_user_has_consent('menstrual_tracking')
)
WITH CHECK (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND app.current_user_has_consent('menstrual_tracking')
);

DROP POLICY IF EXISTS menstrual_profile_revisions_select_own_consented
ON app.menstrual_profile_revisions;
DROP POLICY IF EXISTS menstrual_profile_revisions_insert_own_consented
ON app.menstrual_profile_revisions;
DROP POLICY IF EXISTS menstrual_revisions_select_authorized
ON app.menstrual_profile_revisions;
DROP POLICY IF EXISTS menstrual_revisions_insert_authorized
ON app.menstrual_profile_revisions;
DROP POLICY IF EXISTS menstrual_revisions_granted_select
ON app.menstrual_profile_revisions;
DROP POLICY IF EXISTS menstrual_revisions_granted_insert
ON app.menstrual_profile_revisions;
CREATE POLICY menstrual_profile_revisions_select_own_consented
ON app.menstrual_profile_revisions FOR SELECT TO diet_app
USING (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND app.current_user_has_consent('menstrual_tracking')
);
CREATE POLICY menstrual_profile_revisions_insert_own_consented
ON app.menstrual_profile_revisions FOR INSERT TO diet_app
WITH CHECK (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND app.current_user_has_consent('menstrual_tracking')
);

DROP POLICY IF EXISTS user_consents_select_own ON app.user_consents;
DROP POLICY IF EXISTS user_consents_insert_own ON app.user_consents;
DROP POLICY IF EXISTS consents_select_own ON app.user_consents;
DROP POLICY IF EXISTS consents_insert_own ON app.user_consents;
DROP POLICY IF EXISTS consents_self_select ON app.user_consents;
DROP POLICY IF EXISTS consents_self_insert ON app.user_consents;
CREATE POLICY user_consents_select_own
ON app.user_consents FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());
CREATE POLICY user_consents_insert_own
ON app.user_consents FOR INSERT TO diet_app
WITH CHECK (user_id = app.current_user_id() AND app.current_user_is_active());

DROP POLICY IF EXISTS user_events_select_own ON app.user_events;
DROP POLICY IF EXISTS user_events_insert_own ON app.user_events;
DROP POLICY IF EXISTS events_select_own_or_sensitive_authorized ON app.user_events;
DROP POLICY IF EXISTS events_insert_own_or_sensitive_authorized ON app.user_events;
DROP POLICY IF EXISTS events_self_select ON app.user_events;
DROP POLICY IF EXISTS events_self_insert ON app.user_events;
CREATE POLICY user_events_select_own
ON app.user_events FOR SELECT TO diet_app
USING (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND status = 'active'
  AND (
    event_type NOT IN ('menstrual_period_start', 'menstrual_symptom')
    OR app.current_user_has_consent('menstrual_tracking')
  )
);
CREATE POLICY user_events_insert_own
ON app.user_events FOR INSERT TO diet_app
WITH CHECK (
  user_id = app.current_user_id()
  AND app.current_user_is_active()
  AND status = 'active'
  AND (
    event_type NOT IN ('menstrual_period_start', 'menstrual_symptom')
    OR app.current_user_has_consent('menstrual_tracking')
  )
);

COMMIT;

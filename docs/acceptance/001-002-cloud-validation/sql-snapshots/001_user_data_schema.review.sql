-- REVIEW ONLY: 审核通过前不要在腾讯云 PostgreSQL 执行。
-- Contract source: backend/src/domain/userDataContract.js (schemaVersion = 1)
-- Runtime role: diet_app; object owner / migration role: diet_owner.

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.user_id', true), '');
$$;

CREATE OR REPLACE FUNCTION app.valid_text_array(
  values_to_check text[],
  max_items integer,
  max_item_length integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    coalesce(cardinality(values_to_check), 0) <= max_items
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(coalesce(values_to_check, ARRAY[]::text[])) AS item
      WHERE item IS NULL OR length(item) < 1 OR length(item) > max_item_length
    );
$$;

CREATE TABLE app.users (
  user_id varchar(128) PRIMARY KEY,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'merged', 'disabled')),
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  merged_into_user_id varchar(128) NULL REFERENCES app.users(user_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (merged_into_user_id IS NULL OR merged_into_user_id <> user_id)
);

-- 普通当前档案。数据库列使用 snake_case；与 JS 契约的映射见配套审核文档。
CREATE TABLE app.user_profiles (
  user_id varchar(128) PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),

  equation_sex varchar(10) NULL CHECK (equation_sex IN ('female', 'male')),
  age_years numeric(5,2) NULL CHECK (age_years BETWEEN 14 AND 100),
  height_cm numeric(6,2) NULL CHECK (height_cm BETWEEN 120 AND 230),
  current_weight_kg numeric(6,2) NULL CHECK (current_weight_kg BETWEEN 10 AND 500),
  target_weight_kg numeric(6,2) NULL CHECK (target_weight_kg BETWEEN 10 AND 500),
  daily_activity varchar(200) NULL,
  recent_weight_change varchar(200) NULL,

  scene varchar(20) NOT NULL DEFAULT 'unknown'
    CHECK (scene IN ('cafeteria', 'takeaway', 'mixed', 'unknown')),
  cafeteria_mode varchar(20) NOT NULL DEFAULT 'unknown'
    CHECK (cafeteria_mode IN ('self_select', 'fixed_set', 'mixed', 'unknown')),
  budget_cny_per_meal numeric(10,2) NULL CHECK (budget_cny_per_meal BETWEEN 0 AND 10000),
  taste_preferences text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (app.valid_text_array(taste_preferences, 100, 100)),
  restrictions text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (app.valid_text_array(restrictions, 100, 200)),
  goals text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (app.valid_text_array(goals, 50, 200)),
  exercise_baseline varchar(300) NULL,

  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 经期档案独立存放，避免撤回授权后仍通过普通档案读取。
CREATE TABLE app.user_menstrual_profiles (
  user_id varchar(128) PRIMARY KEY REFERENCES app.users(user_id) ON DELETE CASCADE,
  applicability varchar(20) NOT NULL DEFAULT 'unknown'
    CHECK (applicability IN ('applicable', 'not_applicable', 'unknown')),
  status varchar(20) NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('pending', 'active', 'declined', 'unknown')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 普通档案历史快照；不允许写入 menstrualTracking，敏感历史使用下一张表。
CREATE TABLE app.profile_revisions (
  revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 1),
  profile_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(profile_snapshot) = 'object')
    CHECK (NOT (profile_snapshot ? 'menstrualTracking')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, revision)
);

CREATE TABLE app.menstrual_profile_revisions (
  revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 1),
  menstrual_snapshot jsonb NOT NULL CHECK (jsonb_typeof(menstrual_snapshot) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, revision)
);

-- 授权只追加，不覆盖；最新一条决定当前授权状态。
CREATE TABLE app.user_consents (
  consent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  consent_type varchar(40) NOT NULL
    CHECK (consent_type IN ('long_term_profile', 'menstrual_tracking', 'proactive_reminders')),
  status varchar(20) NOT NULL CHECK (status IN ('granted', 'declined', 'revoked')),
  recorded_at timestamptz NOT NULL,
  source varchar(20) NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'system')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX user_consents_latest_idx
  ON app.user_consents (user_id, consent_type, recorded_at DESC, created_at DESC);

CREATE OR REPLACE FUNCTION app.has_active_consent(
  target_user_id text,
  target_consent_type text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT coalesce((
    SELECT c.status = 'granted'
    FROM app.user_consents AS c
    WHERE c.user_id = target_user_id
      AND c.consent_type = target_consent_type
    ORDER BY c.recorded_at DESC, c.created_at DESC, c.consent_id DESC
    LIMIT 1
  ), false);
$$;

CREATE TABLE app.user_events (
  event_id varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id) ON DELETE CASCADE,
  event_type varchar(40) NOT NULL CHECK (event_type IN (
    'meal', 'snack', 'body_measurement', 'exercise',
    'menstrual_period_start', 'menstrual_symptom', 'check_in',
    'plan_interruption', 'user_correction'
  )),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  source varchar(20) NOT NULL DEFAULT 'user'
    CHECK (source IN ('user', 'secretary', 'device', 'import', 'system')),
  idempotency_key varchar(200) NULL,
  supersedes_event_id varchar(128) NULL,
  CHECK (octet_length(payload::text) <= 51200),
  CHECK (event_type <> 'user_correction' OR supersedes_event_id IS NOT NULL),
  UNIQUE (user_id, event_id),
  FOREIGN KEY (user_id, supersedes_event_id)
    REFERENCES app.user_events(user_id, event_id)
);

CREATE UNIQUE INDEX user_events_idempotency_uq
  ON app.user_events (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX user_events_timeline_idx
  ON app.user_events (user_id, occurred_at DESC, recorded_at DESC);

-- RLS：应用连接必须在每个事务先设置：
-- SELECT set_config('app.user_id', '<validated-user-id>', true);
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_menstrual_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.menstrual_profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self_select ON app.users FOR SELECT TO diet_app
  USING (user_id = app.current_user_id());
CREATE POLICY users_self_insert ON app.users FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY users_self_update ON app.users FOR UPDATE TO diet_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY profiles_self_select ON app.user_profiles FOR SELECT TO diet_app
  USING (user_id = app.current_user_id());
CREATE POLICY profiles_self_insert ON app.user_profiles FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY profiles_self_update ON app.user_profiles FOR UPDATE TO diet_app
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY profile_revisions_self_select ON app.profile_revisions FOR SELECT TO diet_app
  USING (user_id = app.current_user_id());
CREATE POLICY profile_revisions_self_insert ON app.profile_revisions FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY consents_self_select ON app.user_consents FOR SELECT TO diet_app
  USING (user_id = app.current_user_id());
CREATE POLICY consents_self_insert ON app.user_consents FOR INSERT TO diet_app
  WITH CHECK (user_id = app.current_user_id());

-- 敏感档案：必须属于当前用户，且最新 menstrual_tracking 授权为 granted。
-- revoked/declined 后历史仍保留但 diet_app 不可读写；再次 granted 后恢复访问。
CREATE POLICY menstrual_profiles_granted_select ON app.user_menstrual_profiles FOR SELECT TO diet_app
  USING (
    user_id = app.current_user_id()
    AND app.has_active_consent(user_id, 'menstrual_tracking')
  );
CREATE POLICY menstrual_profiles_granted_insert ON app.user_menstrual_profiles FOR INSERT TO diet_app
  WITH CHECK (
    user_id = app.current_user_id()
    AND app.has_active_consent(user_id, 'menstrual_tracking')
  );
CREATE POLICY menstrual_profiles_granted_update ON app.user_menstrual_profiles FOR UPDATE TO diet_app
  USING (
    user_id = app.current_user_id()
    AND app.has_active_consent(user_id, 'menstrual_tracking')
  )
  WITH CHECK (
    user_id = app.current_user_id()
    AND app.has_active_consent(user_id, 'menstrual_tracking')
  );

CREATE POLICY menstrual_revisions_granted_select ON app.menstrual_profile_revisions FOR SELECT TO diet_app
  USING (
    user_id = app.current_user_id()
    AND app.has_active_consent(user_id, 'menstrual_tracking')
  );
CREATE POLICY menstrual_revisions_granted_insert ON app.menstrual_profile_revisions FOR INSERT TO diet_app
  WITH CHECK (
    user_id = app.current_user_id()
    AND app.has_active_consent(user_id, 'menstrual_tracking')
  );

CREATE POLICY events_granted_select ON app.user_events FOR SELECT TO diet_app
  USING (
    user_id = app.current_user_id()
    AND (
      event_type NOT IN ('menstrual_period_start', 'menstrual_symptom')
      OR app.has_active_consent(user_id, 'menstrual_tracking')
    )
  );
CREATE POLICY events_granted_insert ON app.user_events FOR INSERT TO diet_app
  WITH CHECK (
    user_id = app.current_user_id()
    AND (
      event_type NOT IN ('menstrual_period_start', 'menstrual_symptom')
      OR app.has_active_consent(user_id, 'menstrual_tracking')
    )
  );

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.users, app.user_profiles TO diet_app;
GRANT SELECT, INSERT, UPDATE ON app.user_menstrual_profiles TO diet_app;
GRANT SELECT, INSERT ON app.profile_revisions, app.menstrual_profile_revisions TO diet_app;
GRANT SELECT, INSERT ON app.user_consents, app.user_events TO diet_app;

REVOKE ALL ON FUNCTION app.has_active_consent(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO diet_app;
GRANT EXECUTE ON FUNCTION app.valid_text_array(text[], integer, integer) TO diet_app;
GRANT EXECUTE ON FUNCTION app.has_active_consent(text, text) TO diet_app;

COMMIT;

-- 审核后的验证查询（本文件尚未执行时会显示无表）：
-- SELECT schemaname, tablename, tableowner, rowsecurity
-- FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename;

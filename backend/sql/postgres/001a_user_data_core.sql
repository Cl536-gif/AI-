-- 001a: 用户身份、档案、经期、事件与授权核心表
-- 目标数据库：diet_secretary
-- 执行身份：admin_rag（通过 SET LOCAL ROLE 让对象归 diet_owner 所有）
-- 本文件不包含提醒、订阅、方案生命周期和 RAG 表。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.jsonb_string_array_is_valid(
  value jsonb,
  max_items integer,
  max_item_length integer
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  item jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > max_items THEN
    RETURN false;
  END IF;

  FOR item IN SELECT element FROM jsonb_array_elements(value) AS elements(element)
  LOOP
    IF jsonb_typeof(item) <> 'string'
       OR char_length(item #>> '{}') < 1
       OR char_length(item #>> '{}') > max_item_length THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION app.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TABLE app.users (
  user_id varchar(128) PRIMARY KEY,
  status varchar(16) NOT NULL DEFAULT 'active',
  merged_into_user_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT users_user_id_format_chk
    CHECK (user_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT users_status_chk
    CHECK (status IN ('active', 'merged', 'disabled')),
  CONSTRAINT users_merge_state_chk
    CHECK (
      (status = 'merged' AND merged_into_user_id IS NOT NULL AND merged_into_user_id <> user_id)
      OR (status <> 'merged' AND merged_into_user_id IS NULL)
    ),
  CONSTRAINT users_merged_into_fk
    FOREIGN KEY (merged_into_user_id) REFERENCES app.users(user_id)
);

CREATE TABLE app.user_profiles (
  user_id varchar(128) PRIMARY KEY REFERENCES app.users(user_id),
  schema_version smallint NOT NULL DEFAULT 1,

  equation_sex varchar(8),
  age_years numeric(5,2),
  height_cm numeric(6,2),
  -- 档案当前值；单次称重写入 user_events.body_measurement.payload.weightKg。
  current_weight_kg numeric(7,3),
  target_weight_kg numeric(7,3),
  daily_activity varchar(200),
  recent_weight_change varchar(200),

  scene varchar(16) NOT NULL DEFAULT 'unknown',
  cafeteria_mode varchar(16) NOT NULL DEFAULT 'unknown',
  budget_cny_per_meal numeric(10,2),
  taste_preferences jsonb NOT NULL DEFAULT '[]'::jsonb,
  restrictions jsonb NOT NULL DEFAULT '[]'::jsonb,
  goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  exercise_baseline varchar(300),

  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT user_profiles_schema_version_chk CHECK (schema_version = 1),
  CONSTRAINT user_profiles_equation_sex_chk CHECK (equation_sex IS NULL OR equation_sex IN ('female', 'male')),
  CONSTRAINT user_profiles_age_years_chk CHECK (age_years IS NULL OR age_years BETWEEN 14 AND 100),
  CONSTRAINT user_profiles_height_cm_chk CHECK (height_cm IS NULL OR height_cm BETWEEN 120 AND 230),
  CONSTRAINT user_profiles_current_weight_kg_chk CHECK (current_weight_kg IS NULL OR current_weight_kg BETWEEN 10 AND 500),
  CONSTRAINT user_profiles_target_weight_kg_chk CHECK (target_weight_kg IS NULL OR target_weight_kg BETWEEN 10 AND 500),
  CONSTRAINT user_profiles_scene_chk CHECK (scene IN ('cafeteria', 'takeaway', 'mixed', 'unknown')),
  CONSTRAINT user_profiles_cafeteria_mode_chk CHECK (cafeteria_mode IN ('self_select', 'fixed_set', 'mixed', 'unknown')),
  CONSTRAINT user_profiles_budget_chk CHECK (budget_cny_per_meal IS NULL OR budget_cny_per_meal BETWEEN 0 AND 10000),
  CONSTRAINT user_profiles_taste_preferences_chk CHECK (app.jsonb_string_array_is_valid(taste_preferences, 100, 100)),
  CONSTRAINT user_profiles_restrictions_chk CHECK (app.jsonb_string_array_is_valid(restrictions, 100, 200)),
  CONSTRAINT user_profiles_goals_chk CHECK (app.jsonb_string_array_is_valid(goals, 50, 200))
);

CREATE TABLE app.user_menstrual_profiles (
  user_id varchar(128) PRIMARY KEY REFERENCES app.users(user_id),
  applicability varchar(16) NOT NULL DEFAULT 'unknown',
  status varchar(16) NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT menstrual_profiles_applicability_chk
    CHECK (applicability IN ('applicable', 'not_applicable', 'unknown')),
  CONSTRAINT menstrual_profiles_status_chk
    CHECK (status IN ('pending', 'active', 'declined', 'unknown'))
);

CREATE TABLE app.profile_revisions (
  revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id),
  schema_version smallint NOT NULL DEFAULT 1,
  profile_snapshot jsonb NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'system',
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profile_revisions_schema_version_chk CHECK (schema_version = 1),
  CONSTRAINT profile_revisions_snapshot_object_chk CHECK (jsonb_typeof(profile_snapshot) = 'object'),
  -- 经期信息必须进入独立敏感表，禁止混进普通档案快照。
  CONSTRAINT profile_revisions_no_menstrual_data_chk CHECK (
    NOT (profile_snapshot ? 'menstrualTracking')
    AND NOT (profile_snapshot ? 'menstrual_tracking')
  ),
  CONSTRAINT profile_revisions_source_chk
    CHECK (source IN ('user', 'secretary', 'device', 'import', 'system'))
);

CREATE TABLE app.menstrual_profile_revisions (
  revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id),
  menstrual_snapshot jsonb NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'system',
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT menstrual_revisions_snapshot_object_chk CHECK (jsonb_typeof(menstrual_snapshot) = 'object'),
  CONSTRAINT menstrual_revisions_source_chk
    CHECK (source IN ('user', 'secretary', 'device', 'import', 'system'))
);

CREATE TABLE app.user_consents (
  consent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id),
  consent_type varchar(32) NOT NULL,
  status varchar(16) NOT NULL,
  recorded_at timestamptz NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'user',
  CONSTRAINT user_consents_type_chk
    CHECK (consent_type IN ('long_term_profile', 'menstrual_tracking', 'proactive_reminders')),
  CONSTRAINT user_consents_status_chk
    CHECK (status IN ('granted', 'declined', 'revoked')),
  CONSTRAINT user_consents_source_chk
    CHECK (source IN ('user', 'system'))
);

CREATE TABLE app.user_events (
  event_id varchar(128) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id),
  event_type varchar(32) NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'user',
  idempotency_key varchar(200),
  supersedes_event_id varchar(128),
  CONSTRAINT user_events_user_event_unique UNIQUE (user_id, event_id),
  CONSTRAINT user_events_type_chk CHECK (event_type IN (
    'meal', 'snack', 'body_measurement', 'exercise',
    'menstrual_period_start', 'menstrual_symptom', 'check_in',
    'plan_interruption', 'user_correction'
  )),
  CONSTRAINT user_events_payload_object_chk CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT user_events_payload_size_chk CHECK (octet_length(payload::text) <= 51200),
  CONSTRAINT user_events_source_chk
    CHECK (source IN ('user', 'secretary', 'device', 'import', 'system')),
  CONSTRAINT user_events_correction_target_chk
    CHECK (event_type <> 'user_correction' OR supersedes_event_id IS NOT NULL),
  CONSTRAINT user_events_supersedes_same_user_fk
    FOREIGN KEY (user_id, supersedes_event_id)
    REFERENCES app.user_events(user_id, event_id)
);

CREATE UNIQUE INDEX user_events_idempotency_uidx
  ON app.user_events (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX user_events_user_occurred_idx
  ON app.user_events (user_id, occurred_at DESC, event_id DESC);
CREATE INDEX user_events_user_type_occurred_idx
  ON app.user_events (user_id, event_type, occurred_at DESC);
CREATE INDEX user_consents_latest_idx
  ON app.user_consents (user_id, consent_type, recorded_at DESC, consent_id DESC);
CREATE INDEX profile_revisions_user_recorded_idx
  ON app.profile_revisions (user_id, recorded_at DESC, revision_id DESC);
CREATE INDEX menstrual_revisions_user_recorded_idx
  ON app.menstrual_profile_revisions (user_id, recorded_at DESC, revision_id DESC);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON app.users
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER user_profiles_set_updated_at
BEFORE UPDATE ON app.user_profiles
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER menstrual_profiles_set_updated_at
BEFORE UPDATE ON app.user_menstrual_profiles
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

COMMENT ON COLUMN app.user_profiles.current_weight_kg IS
  '档案中的当前体重；单次称重事件使用 app.user_events(event_type=body_measurement).payload.weightKg。';
COMMENT ON COLUMN app.user_events.payload IS
  '暂时仅约束为<=50KiB的JSON对象；meal/exercise等字段级payload契约将在后续版本化迁移中收紧。';
COMMENT ON TABLE app.user_menstrual_profiles IS
  '经期当前状态的敏感独立表；读取和写入必须同时满足用户归属与当前有效授权。';

COMMIT;

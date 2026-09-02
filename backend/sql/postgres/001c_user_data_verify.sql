-- 001c: 元数据验收 + 可回滚的业务角色冒烟测试
-- 前置：001a 与 001b 均已成功提交。

-- A. 表、所有者与 RLS 状态：预期7张表，owner=diet_owner，RLS与FORCE均为true。
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  r.rolname AS table_owner,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_roles AS r ON r.oid = c.relowner
WHERE n.nspname = 'app'
  AND c.relkind = 'r'
ORDER BY c.relname;

-- B. 策略清单：预期每张表都有对应的自有用户策略；经期表策略名包含 authorized。
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'app'
ORDER BY tablename, policyname;

-- C. diet_app 不应拥有 schema CREATE，也不应拥有 DELETE/TRUNCATE。
SELECT
  has_schema_privilege('diet_app', 'app', 'USAGE') AS app_usage,
  has_schema_privilege('diet_app', 'app', 'CREATE') AS app_create,
  has_table_privilege('diet_app', 'app.user_events', 'DELETE') AS events_delete,
  has_table_privilege('diet_app', 'app.user_events', 'TRUNCATE') AS events_truncate;

-- D. 正常写入冒烟测试。整段最后 ROLLBACK，不保留探针数据。
BEGIN;
SET LOCAL ROLE diet_app;
SET LOCAL app.user_id = 'migration_probe_user';

INSERT INTO app.users (user_id) VALUES ('migration_probe_user');

INSERT INTO app.user_profiles (
  user_id, equation_sex, age_years, height_cm, current_weight_kg,
  scene, cafeteria_mode, budget_cny_per_meal,
  taste_preferences, restrictions, goals, exercise_baseline
) VALUES (
  'migration_probe_user', 'female', 22, 165, 60,
  'cafeteria', 'self_select', 30,
  '["酸甜"]'::jsonb, '[]'::jsonb, '["拍照更上镜"]'::jsonb, '目前不运动'
);

INSERT INTO app.profile_revisions (user_id, profile_snapshot, source)
VALUES (
  'migration_probe_user',
  '{"schemaVersion":1,"body":{"ageYears":22,"heightCm":165,"currentWeightKg":60},"diet":{"scene":"cafeteria"}}'::jsonb,
  'system'
);

INSERT INTO app.user_consents (
  user_id, consent_type, status, recorded_at, source
) VALUES (
  'migration_probe_user', 'menstrual_tracking', 'granted', clock_timestamp(), 'user'
);

INSERT INTO app.user_menstrual_profiles (user_id, applicability, status)
VALUES ('migration_probe_user', 'applicable', 'active');

INSERT INTO app.menstrual_profile_revisions (user_id, menstrual_snapshot, source)
VALUES ('migration_probe_user', '{"applicability":"applicable","status":"active"}'::jsonb, 'system');

INSERT INTO app.user_events (
  user_id, event_type, occurred_at, payload, source, idempotency_key
) VALUES
  ('migration_probe_user', 'body_measurement', clock_timestamp(), '{"weightKg":60}'::jsonb, 'user', 'probe-weight-1'),
  ('migration_probe_user', 'menstrual_period_start', clock_timestamp(), '{"date":"2026-08-14"}'::jsonb, 'user', 'probe-period-1');

SELECT
  (SELECT count(*) FROM app.users) AS visible_users,
  (SELECT count(*) FROM app.user_profiles) AS visible_profiles,
  (SELECT count(*) FROM app.user_events) AS visible_events,
  (SELECT count(*) FROM app.user_menstrual_profiles) AS visible_menstrual_profiles;

ROLLBACK;

-- E. 探针数据应为0，证明验收没有污染正式数据库。
SELECT count(*) AS probe_rows_after_rollback
FROM app.users
WHERE user_id = 'migration_probe_user';

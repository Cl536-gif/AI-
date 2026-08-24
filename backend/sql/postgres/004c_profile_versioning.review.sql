-- REVIEW ONLY: 004c 用户档案统一版本账本与乐观并发控制。
-- 前置：001-003 已部署；save_current_user_profile 与
-- save_current_user_menstrual_profile 已按验收版本存在。
-- 本文件未审核和云端沙箱验证前，不得在生产数据库执行。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE OR REPLACE FUNCTION app.profile_changed_fields_is_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'array' THEN false
    ELSE jsonb_array_length(value) <= 3
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(value) AS item(element)
        WHERE jsonb_typeof(item.element) <> 'string'
      )
  END
$function$;

ALTER FUNCTION app.profile_changed_fields_is_valid(jsonb)
  OWNER TO diet_owner;
REVOKE ALL ON FUNCTION app.profile_changed_fields_is_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_changed_fields_is_valid(jsonb) TO diet_owner;

-- 普通档案和经期档案继续物理分离。此表只保存版本号，不保存快照。
CREATE TABLE app.user_profile_versions (
  user_id varchar(128) PRIMARY KEY REFERENCES app.users(user_id),
  current_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_profile_versions_nonnegative_chk
    CHECK (current_version >= 0)
);

-- 统一历史只引用已有分表修订，不复制任何敏感内容。
ALTER TABLE app.menstrual_profile_revisions
  ADD CONSTRAINT menstrual_profile_revisions_user_revision_unique
  UNIQUE (user_id, revision_id);

CREATE TABLE app.user_profile_version_history (
  user_id varchar(128) NOT NULL REFERENCES app.users(user_id),
  profile_version integer NOT NULL,
  normal_revision_id uuid,
  menstrual_revision_id uuid,
  changed_fields jsonb NOT NULL,
  source varchar(16) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, profile_version),
  CONSTRAINT user_profile_version_history_positive_chk
    CHECK (profile_version > 0),
  CONSTRAINT user_profile_version_history_reference_chk
    CHECK (normal_revision_id IS NOT NULL OR menstrual_revision_id IS NOT NULL),
  CONSTRAINT user_profile_version_history_changed_fields_chk
    CHECK (app.profile_changed_fields_is_valid(changed_fields)),
  CONSTRAINT user_profile_version_history_source_chk
    CHECK (source IN ('user', 'secretary', 'device', 'import', 'system')),
  CONSTRAINT user_profile_version_history_normal_fk
    FOREIGN KEY (user_id, normal_revision_id)
    REFERENCES app.profile_revisions(user_id, revision_id),
  CONSTRAINT user_profile_version_history_menstrual_fk
    FOREIGN KEY (user_id, menstrual_revision_id)
    REFERENCES app.menstrual_profile_revisions(user_id, revision_id)
);

CREATE INDEX user_profile_version_history_recorded_idx
  ON app.user_profile_version_history (
    user_id, recorded_at DESC, profile_version DESC
  );

-- 已有档案若没有任何历史，无法证明版本来源；迁移必须失败关闭。
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.user_profiles AS profile
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.profile_revisions AS revision
      WHERE revision.user_id = profile.user_id
    )
  ) OR EXISTS (
    SELECT 1
    FROM app.user_menstrual_profiles AS profile
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.menstrual_profile_revisions AS revision
      WHERE revision.user_id = profile.user_id
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '存在没有历史修订的当前档案，004c拒绝推测版本来源';
  END IF;
END
$preflight$;

-- 按真实入库顺序把普通/经期历史合并为统一版本序列。
WITH combined AS (
  SELECT
    revision.user_id,
    revision.revision_id AS normal_revision_id,
    NULL::uuid AS menstrual_revision_id,
    '[]'::jsonb AS changed_fields,
    revision.source,
    revision.recorded_at,
    0 AS kind_order,
    revision.revision_id AS stable_id
  FROM app.profile_revisions AS revision
  UNION ALL
  SELECT
    revision.user_id,
    NULL::uuid AS normal_revision_id,
    revision.revision_id AS menstrual_revision_id,
    '["menstrualTracking"]'::jsonb AS changed_fields,
    revision.source,
    revision.recorded_at,
    1 AS kind_order,
    revision.revision_id AS stable_id
  FROM app.menstrual_profile_revisions AS revision
), ranked AS (
  SELECT
    combined.*,
    row_number() OVER (
      PARTITION BY combined.user_id
      ORDER BY combined.recorded_at, combined.kind_order, combined.stable_id
    )::integer AS profile_version
  FROM combined
)
INSERT INTO app.user_profile_version_history (
  user_id,
  profile_version,
  normal_revision_id,
  menstrual_revision_id,
  changed_fields,
  source,
  recorded_at
)
SELECT
  ranked.user_id,
  ranked.profile_version,
  ranked.normal_revision_id,
  ranked.menstrual_revision_id,
  ranked.changed_fields,
  ranked.source,
  ranked.recorded_at
FROM ranked;

INSERT INTO app.user_profile_versions (
  user_id,
  current_version,
  created_at,
  updated_at
)
SELECT
  history.user_id,
  MAX(history.profile_version),
  MIN(history.recorded_at),
  MAX(history.recorded_at)
FROM app.user_profile_version_history AS history
GROUP BY history.user_id;

ALTER TABLE app.user_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_profile_version_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_profile_versions_select_own
ON app.user_profile_versions FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

CREATE POLICY user_profile_version_history_select_own
ON app.user_profile_version_history FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

GRANT SELECT ON app.user_profile_versions TO diet_app;
GRANT SELECT ON app.user_profile_version_history TO diet_app;

-- 保留已验收实现供新原子入口内部调用；应用角色不能直接绕过版本账本。
ALTER FUNCTION app.save_current_user_profile(jsonb, varchar)
  RENAME TO save_current_user_profile_legacy_004c;

REVOKE ALL
ON FUNCTION app.save_current_user_profile_legacy_004c(jsonb, varchar)
FROM PUBLIC, diet_app;

CREATE OR REPLACE FUNCTION app.save_current_user_profile_versioned(
  p_profile jsonb,
  p_source varchar,
  p_expected_version integer,
  p_changed_fields jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_user_status varchar;
  v_current_version integer;
  v_next_version integer;
  v_changed_field text;
  v_normal_revision_id uuid;
  v_menstrual_revision_id uuid;
  v_profile jsonb := p_profile;
  v_normal_profile jsonb;
  v_saved_normal jsonb;
  v_saved_menstrual jsonb;
  v_normal_save_started_at timestamptz;
  v_menstrual_save_started_at timestamptz;
  v_created_at timestamptz;
  v_updated_at timestamptz;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF p_profile IS NULL OR jsonb_typeof(p_profile) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_profile必须是JSON对象';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_profile) AS top_key(key)
    WHERE top_key.key NOT IN (
      'schemaVersion', 'body', 'diet', 'menstrualTracking'
    )
  ) OR NOT (p_profile ? 'schemaVersion')
     OR NOT (p_profile ? 'body')
     OR NOT (p_profile ? 'diet')
     OR p_profile ->> 'schemaVersion' <> '1'
     OR jsonb_typeof(p_profile -> 'body') <> 'object'
     OR jsonb_typeof(p_profile -> 'diet') <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'p_profile顶层结构不符合UserProfileSchema';
  END IF;

  IF p_expected_version IS NOT NULL AND p_expected_version < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'expectedVersion不能小于0';
  END IF;

  IF p_changed_fields IS NULL
     OR jsonb_typeof(p_changed_fields) <> 'array'
     OR jsonb_array_length(p_changed_fields) = 0
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_changed_fields) AS item(value)
       WHERE jsonb_typeof(item.value) <> 'string'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'changedFields必须是非空字符串数组';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_changed_fields) AS field(value)
    WHERE field.value NOT IN ('body', 'diet', 'menstrualTracking')
  ) OR (
    SELECT COUNT(*) FROM jsonb_array_elements_text(p_changed_fields)
  ) <> (
    SELECT COUNT(DISTINCT value)
    FROM jsonb_array_elements_text(p_changed_fields) AS field(value)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'changedFields包含未知或重复字段';
  END IF;

  INSERT INTO app.users (user_id, status)
  VALUES (v_user_id, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT users.status
  INTO v_user_status
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_user_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  INSERT INTO app.user_profile_versions (user_id, current_version)
  VALUES (v_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT versions.current_version, versions.created_at
  INTO v_current_version, v_created_at
  FROM app.user_profile_versions AS versions
  WHERE versions.user_id = v_user_id
  FOR UPDATE;

  IF p_expected_version IS NOT NULL
     AND p_expected_version <> v_current_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = '用户档案版本冲突，请读取最新版本后重试';
  END IF;

  v_next_version := v_current_version + 1;

  FOR v_changed_field IN
    SELECT value FROM jsonb_array_elements_text(p_changed_fields)
  LOOP
    IF NOT (p_profile ? v_changed_field) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = format('p_profile缺少changedFields声明的字段%s', v_changed_field);
    END IF;
  END LOOP;

  IF p_changed_fields ? 'body' OR p_changed_fields ? 'diet' THEN
    IF NOT (p_profile ? 'body') OR NOT (p_profile ? 'diet') THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = '普通档案更新必须包含完整body和diet';
    END IF;
    v_normal_profile := p_profile - 'menstrualTracking';
    v_normal_save_started_at := clock_timestamp();
    v_saved_normal := app.save_current_user_profile_legacy_004c(
      v_normal_profile,
      p_source
    );

    SELECT revision.revision_id
    INTO v_normal_revision_id
    FROM app.profile_revisions AS revision
    WHERE revision.user_id = v_user_id
      AND revision.profile_snapshot = v_saved_normal
      AND revision.source = p_source
      AND revision.recorded_at >= v_normal_save_started_at
    ORDER BY revision.recorded_at DESC, revision.revision_id DESC
    LIMIT 1;
  END IF;

  IF p_changed_fields ? 'menstrualTracking' THEN
    v_menstrual_save_started_at := clock_timestamp();
    v_saved_menstrual := app.save_current_user_menstrual_profile(
      p_profile -> 'menstrualTracking',
      p_source
    );

    SELECT revision.revision_id
    INTO v_menstrual_revision_id
    FROM app.menstrual_profile_revisions AS revision
    WHERE revision.user_id = v_user_id
      AND revision.menstrual_snapshot = v_saved_menstrual
      AND revision.source = p_source
      AND revision.recorded_at >= v_menstrual_save_started_at
    ORDER BY revision.recorded_at DESC, revision.revision_id DESC
    LIMIT 1;
  END IF;

  IF v_normal_revision_id IS NULL AND v_menstrual_revision_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = '档案修订未生成';
  END IF;

  v_updated_at := clock_timestamp();

  UPDATE app.user_profile_versions
  SET current_version = v_next_version,
      updated_at = v_updated_at
  WHERE user_id = v_user_id
    AND current_version = v_current_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = '用户档案版本并发更新失败';
  END IF;

  INSERT INTO app.user_profile_version_history (
    user_id,
    profile_version,
    normal_revision_id,
    menstrual_revision_id,
    changed_fields,
    source,
    recorded_at
  )
  VALUES (
    v_user_id,
    v_next_version,
    v_normal_revision_id,
    v_menstrual_revision_id,
    p_changed_fields,
    p_source,
    v_updated_at
  );

  RETURN jsonb_build_object(
    'userId', v_user_id,
    'profileVersion', v_next_version,
    'profile', v_profile,
    'createdAt', v_created_at,
    'updatedAt', v_updated_at
  );
END;
$function$;

ALTER FUNCTION app.save_current_user_profile_versioned(
  jsonb, varchar, integer, jsonb
) OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.save_current_user_profile_versioned(
  jsonb, varchar, integer, jsonb
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app.save_current_user_profile_versioned(
  jsonb, varchar, integer, jsonb
)
TO diet_app, diet_owner;

-- 兼容002长期建档与身份合并RPC的两参数调用，同时强制进入版本账本。
CREATE OR REPLACE FUNCTION app.save_current_user_profile(
  p_profile jsonb,
  p_source varchar DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT result -> 'profile'
  FROM (
    SELECT app.save_current_user_profile_versioned(
      p_profile,
      p_source,
      NULL,
      '["body", "diet"]'::jsonb
    ) AS result
  ) AS saved
$function$;

ALTER FUNCTION app.save_current_user_profile(jsonb, varchar)
  OWNER TO diet_owner;

REVOKE ALL
ON FUNCTION app.save_current_user_profile(jsonb, varchar)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION app.save_current_user_profile(jsonb, varchar)
TO diet_app, diet_owner;

COMMENT ON TABLE app.user_profile_versions IS
  '普通与经期分表之上的统一档案版本头；不保存档案内容。';
COMMENT ON TABLE app.user_profile_version_history IS
  '统一版本历史，只引用分表修订ID，不复制敏感经期快照。';
COMMENT ON FUNCTION app.save_current_user_profile_versioned(
  jsonb, varchar, integer, jsonb
) IS
  '以当前用户身份原子保存普通/经期档案、校验expectedVersion并追加统一版本历史。';

COMMIT;

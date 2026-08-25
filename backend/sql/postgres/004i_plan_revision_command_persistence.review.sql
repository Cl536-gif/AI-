-- REVIEW ONLY: 004i 计划修订命令持久化。
-- 前置：001-004h 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE TABLE app.plan_revision_commands (
  command_id varchar(128) PRIMARY KEY,
  user_id varchar NOT NULL
    REFERENCES app.users(user_id) ON DELETE CASCADE,
  plan_id varchar(128) NOT NULL,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT plan_revision_commands_user_plan_fk
    FOREIGN KEY (user_id, plan_id)
    REFERENCES app.user_plan_versions(user_id, plan_id) ON DELETE CASCADE,
  CONSTRAINT plan_revision_commands_command_id_chk CHECK (
    char_length(btrim(command_id)) BETWEEN 1 AND 128
  ),
  CONSTRAINT plan_revision_commands_status_chk CHECK (
    status IN ('draft_created', 'delivered')
  ),
  CONSTRAINT plan_revision_commands_timestamps_chk CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX plan_revision_commands_user_updated_idx
  ON app.plan_revision_commands (user_id, updated_at DESC, command_id DESC);

ALTER TABLE app.plan_revision_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.plan_revision_commands NO FORCE ROW LEVEL SECURITY;

CREATE POLICY plan_revision_commands_select_own
ON app.plan_revision_commands FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

REVOKE ALL ON TABLE app.plan_revision_commands FROM PUBLIC, diet_app;
GRANT SELECT ON TABLE app.plan_revision_commands TO diet_app;

CREATE OR REPLACE FUNCTION app.record_current_user_plan_revision_command(
  p_command_id varchar,
  p_plan_id varchar,
  p_status varchar,
  p_recorded_at timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_command_id varchar := NULLIF(btrim(p_command_id), '');
  v_plan_id varchar := NULLIF(btrim(p_plan_id), '');
  v_status varchar := NULLIF(btrim(p_status), '');
  v_recorded_at timestamptz := COALESCE(p_recorded_at, clock_timestamp());
  v_account_status varchar;
  v_plan_status varchar;
  v_existing app.plan_revision_commands%ROWTYPE;
  v_saved app.plan_revision_commands%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF v_command_id IS NULL OR char_length(v_command_id) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划修订命令ID格式不正确';
  END IF;

  IF v_plan_id IS NULL OR char_length(v_plan_id) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划修订命令的计划ID格式不正确';
  END IF;

  IF v_status IS NULL OR v_status NOT IN ('draft_created', 'delivered') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划修订命令状态不正确';
  END IF;

  SELECT users.status
  INTO v_account_status
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  SELECT plan.status
  INTO v_plan_status
  FROM app.user_plan_versions AS plan
  WHERE plan.user_id = v_user_id
    AND plan.plan_id = v_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = '计划修订命令引用的计划不存在或不属于当前用户';
  END IF;

  IF (v_status = 'draft_created' AND v_plan_status <> 'draft')
     OR (v_status = 'delivered' AND v_plan_status <> 'active') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '计划修订命令状态与计划状态不一致';
  END IF;

  SELECT * INTO v_existing
  FROM app.plan_revision_commands
  WHERE command_id = v_command_id
  FOR UPDATE;

  IF FOUND AND v_existing.user_id <> v_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = '计划修订命令ID不可用';
  END IF;

  IF FOUND AND v_existing.plan_id <> v_plan_id THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '同一计划修订命令不能关联不同计划';
  END IF;

  IF FOUND AND v_existing.status = 'delivered' AND v_status = 'draft_created' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '已交付的计划修订命令不能回退为草稿';
  END IF;

  INSERT INTO app.plan_revision_commands (
    command_id,
    user_id,
    plan_id,
    status,
    created_at,
    updated_at
  ) VALUES (
    v_command_id,
    v_user_id,
    v_plan_id,
    v_status,
    v_recorded_at,
    v_recorded_at
  )
  ON CONFLICT (command_id) DO UPDATE
  SET status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  WHERE app.plan_revision_commands.user_id = EXCLUDED.user_id
    AND app.plan_revision_commands.plan_id = EXCLUDED.plan_id
  RETURNING * INTO v_saved;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = '计划修订命令写入发生并发冲突';
  END IF;

  RETURN jsonb_build_object(
    'commandId', v_saved.command_id,
    'userId', v_saved.user_id,
    'planId', v_saved.plan_id,
    'status', v_saved.status,
    'createdAt', v_saved.created_at,
    'updatedAt', v_saved.updated_at
  );
END;
$function$;

ALTER FUNCTION app.record_current_user_plan_revision_command(
  varchar,
  varchar,
  varchar,
  timestamptz
) OWNER TO diet_owner;

REVOKE ALL ON FUNCTION app.record_current_user_plan_revision_command(
  varchar,
  varchar,
  varchar,
  timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.record_current_user_plan_revision_command(
  varchar,
  varchar,
  varchar,
  timestamptz
) TO diet_app, diet_owner;

COMMENT ON TABLE app.plan_revision_commands IS
  '计划修订命令幂等记录；command_id全局唯一且仅当前用户可读取。';

COMMENT ON FUNCTION app.record_current_user_plan_revision_command(
  varchar,
  varchar,
  varchar,
  timestamptz
) IS
  '记录当前用户计划修订命令，允许draft_created到delivered单向推进并拒绝跨用户命令ID复用。';

COMMIT;

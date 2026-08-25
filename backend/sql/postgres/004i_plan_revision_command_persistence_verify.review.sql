-- 004i 云端功能沙箱。所有业务写入均在同一事务中并最终 ROLLBACK。
-- 固定测试ID仅用于零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004i_verify_a', 'acct:004i_verify_b')
  ) OR EXISTS (
    SELECT 1 FROM app.plan_revision_commands
    WHERE command_id = '004i-command-shared'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004i固定沙箱数据已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004i_verify_a', true);
SET LOCAL ROLE diet_app;

DO $create_and_record_draft_command$
DECLARE
  v_plan jsonb;
  v_command jsonb;
  v_plan_id varchar;
BEGIN
  v_plan := app.create_current_user_plan_draft(
    '{"plan":{"label":"004i-draft-a"},"changeReason":"004i_revision"}'::jsonb,
    '2026-08-25T02:00:00Z'::timestamptz
  );
  v_plan_id := v_plan->>'planId';
  PERFORM set_config('app.verify_004i_plan_a', v_plan_id, true);

  v_command := app.record_current_user_plan_revision_command(
    '004i-command-shared',
    v_plan_id,
    'draft_created',
    '2026-08-25T02:01:00Z'::timestamptz
  );

  IF v_command->>'commandId' <> '004i-command-shared'
     OR v_command->>'planId' <> v_plan_id
     OR v_command->>'status' <> 'draft_created'
     OR (SELECT COUNT(*) FROM app.plan_revision_commands
         WHERE user_id = 'acct:004i_verify_a') <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004i草稿命令创建断言失败';
  END IF;
END
$create_and_record_draft_command$;

SELECT 'PASS' AS draft_command_recorded;

DO $assert_draft_retry_is_idempotent$
DECLARE
  v_plan_id varchar := current_setting('app.verify_004i_plan_a');
  v_command jsonb;
BEGIN
  v_command := app.record_current_user_plan_revision_command(
    '004i-command-shared',
    v_plan_id,
    'draft_created',
    '2026-08-25T02:02:00Z'::timestamptz
  );

  IF v_command->>'status' <> 'draft_created'
     OR (SELECT COUNT(*) FROM app.plan_revision_commands
         WHERE command_id = '004i-command-shared') <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004i草稿命令幂等重试断言失败';
  END IF;
END
$assert_draft_retry_is_idempotent$;

SELECT 'PASS' AS draft_retry_idempotent;

DO $advance_command_to_delivered$
DECLARE
  v_plan_id varchar := current_setting('app.verify_004i_plan_a');
  v_command jsonb;
BEGIN
  PERFORM app.transition_current_user_plan(
    v_plan_id,
    'active',
    '004i_revision_delivered',
    '2026-08-25T02:03:00Z'::timestamptz
  );

  v_command := app.record_current_user_plan_revision_command(
    '004i-command-shared',
    v_plan_id,
    'delivered',
    '2026-08-25T02:04:00Z'::timestamptz
  );

  IF v_command->>'status' <> 'delivered'
     OR (SELECT status FROM app.plan_revision_commands
         WHERE command_id = '004i-command-shared') <> 'delivered' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004i命令单向交付断言失败';
  END IF;
END
$advance_command_to_delivered$;

SELECT 'PASS' AS command_advanced_to_delivered;

DO $reject_plan_rebinding$
DECLARE
  v_second_plan jsonb;
  v_error_code varchar;
BEGIN
  v_second_plan := app.create_current_user_plan_draft(
    '{"plan":{"label":"004i-draft-a2"},"changeReason":"004i_rebind_test"}'::jsonb,
    '2026-08-25T02:05:00Z'::timestamptz
  );

  BEGIN
    PERFORM app.record_current_user_plan_revision_command(
      '004i-command-shared',
      v_second_plan->>'planId',
      'draft_created',
      '2026-08-25T02:06:00Z'::timestamptz
    );
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '同一命令重新绑定计划未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      GET STACKED DIAGNOSTICS v_error_code = RETURNED_SQLSTATE;
  END;

  IF v_error_code <> '22023'
     OR (SELECT status FROM app.plan_revision_commands
         WHERE command_id = '004i-command-shared') <> 'delivered' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004i计划重绑定拒绝或原记录保留断言失败';
  END IF;
END
$reject_plan_rebinding$;

SELECT 'PASS' AS plan_rebinding_rejected;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004i_verify_b', true);
SET LOCAL ROLE diet_app;

DO $reject_cross_user_command_collision$
DECLARE
  v_plan jsonb;
  v_error_code varchar;
BEGIN
  v_plan := app.create_current_user_plan_draft(
    '{"plan":{"label":"004i-draft-b"},"changeReason":"004i_cross_user_test"}'::jsonb,
    '2026-08-25T03:00:00Z'::timestamptz
  );

  BEGIN
    PERFORM app.record_current_user_plan_revision_command(
      '004i-command-shared',
      v_plan->>'planId',
      'draft_created',
      '2026-08-25T03:01:00Z'::timestamptz
    );
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '跨用户命令ID复用未被拒绝';
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_error_code = RETURNED_SQLSTATE;
  END;

  IF v_error_code <> '23505'
     OR (SELECT COUNT(*) FROM app.plan_revision_commands) <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004i跨用户冲突或RLS隔离断言失败';
  END IF;
END
$reject_cross_user_command_collision$;

SELECT 'PASS' AS cross_user_collision_rejected_and_isolated;

RESET ROLE;
ROLLBACK;

SELECT
  CASE
    WHEN remaining_users = 0
      AND remaining_plans = 0
      AND remaining_commands = 0
    THEN 'PASS'
    ELSE 'FAIL'
  END AS cleanup_status,
  cleanup.*
FROM (
  SELECT
    (SELECT COUNT(*) FROM app.users
     WHERE user_id IN ('acct:004i_verify_a', 'acct:004i_verify_b')) AS remaining_users,
    (SELECT COUNT(*) FROM app.user_plan_versions
     WHERE user_id IN ('acct:004i_verify_a', 'acct:004i_verify_b')) AS remaining_plans,
    (SELECT COUNT(*) FROM app.plan_revision_commands
     WHERE command_id = '004i-command-shared') AS remaining_commands
) AS cleanup;

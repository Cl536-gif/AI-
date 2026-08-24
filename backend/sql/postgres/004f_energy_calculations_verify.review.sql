-- 004f 云端功能沙箱。所有业务写入均在同一事务中并最终 ROLLBACK。
-- 固定测试ID仅用于回滚后的零残留证明，不读取或输出真实用户数据。
BEGIN;

DO $assert_clean_start$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.users
    WHERE user_id IN ('acct:004f_verify_a', 'acct:004f_verify_b')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = '004f固定沙箱用户已存在，拒绝覆盖';
  END IF;
END
$assert_clean_start$;

SELECT set_config('app.current_user_id', 'acct:004f_verify_a', true);
SET LOCAL ROLE diet_app;

SELECT app.record_current_user_energy_calculation(
  '{
    "formulaId":"FAO_WHO_UNU_SCHOFIELD_BMR_X_CHINA_PAL",
    "formulaVersion":"1.0.0",
    "inputs":{
      "equationSex":"female",
      "ageYears":22,
      "heightCm":165,
      "weightKg":60,
      "activityLevel":"light",
      "pal":1.5
    },
    "assumptions":["adult","non-pregnant"],
    "outputs":{
      "bmi":22,
      "estimatedBmrKcalPerDay":1375.7,
      "estimatedTeeKcalPerDay":2063.5
    },
    "sourceRefs":["https://example.invalid/fao","https://example.invalid/nhc"]
  }'::jsonb,
  '2026-08-24T08:00:00Z'::timestamptz
) AS first_calculation_result;

SELECT app.record_current_user_energy_calculation(
  '{
    "formulaId":"FAO_WHO_UNU_SCHOFIELD_BMR_X_CHINA_PAL",
    "formulaVersion":"1.0.0",
    "inputs":{
      "equationSex":"female",
      "ageYears":22,
      "heightCm":165,
      "weightKg":59.5,
      "activityLevel":"moderate",
      "pal":1.75
    },
    "assumptions":[],
    "outputs":{
      "bmi":21.9,
      "estimatedBmrKcalPerDay":1368.3,
      "estimatedTeeKcalPerDay":2394.5
    },
    "sourceRefs":[]
  }'::jsonb,
  '2026-08-24T09:00:00Z'::timestamptz
) AS second_calculation_result;

DO $assert_append_and_order$
DECLARE
  v_count integer;
  v_distinct_ids integer;
  v_latest_weight numeric;
  v_latest_activity varchar;
  v_latest_created_at timestamptz;
  v_first_assumptions integer;
  v_first_sources integer;
BEGIN
  SELECT
    COUNT(*),
    COUNT(DISTINCT calculation_id)
  INTO v_count, v_distinct_ids
  FROM app.energy_calculations
  WHERE user_id = 'acct:004f_verify_a';

  SELECT
    (inputs->>'weightKg')::numeric,
    inputs->>'activityLevel',
    created_at
  INTO v_latest_weight, v_latest_activity, v_latest_created_at
  FROM app.energy_calculations
  WHERE user_id = 'acct:004f_verify_a'
  ORDER BY created_at DESC, calculation_id DESC
  LIMIT 1;

  SELECT
    jsonb_array_length(assumptions),
    jsonb_array_length(source_refs)
  INTO v_first_assumptions, v_first_sources
  FROM app.energy_calculations
  WHERE user_id = 'acct:004f_verify_a'
  ORDER BY created_at, calculation_id
  LIMIT 1;

  IF v_count <> 2
     OR v_distinct_ids <> 2
     OR v_latest_weight <> 59.5
     OR v_latest_activity <> 'moderate'
     OR v_latest_created_at <> '2026-08-24T09:00:00Z'::timestamptz
     OR v_first_assumptions <> 2
     OR v_first_sources <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004f追加、排序或JSON快照断言失败';
  END IF;
END
$assert_append_and_order$;

SELECT 'PASS' AS append_order_and_snapshot_verified;

DO $assert_invalid_payloads$
DECLARE
  v_count integer;
BEGIN
  BEGIN
    PERFORM app.record_current_user_energy_calculation(
      '{
        "formulaId":"formula",
        "formulaVersion":"1",
        "inputs":{},
        "outputs":{},
        "unexpected":true
      }'::jsonb,
      clock_timestamp()
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '未知字段未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM app.record_current_user_energy_calculation(
      '{
        "formulaId":"formula",
        "formulaVersion":"1",
        "inputs":{},
        "assumptions":{},
        "outputs":{},
        "sourceRefs":[]
      }'::jsonb,
      clock_timestamp()
    );
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '错误假设类型未被拒绝';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;

  SELECT COUNT(*) INTO v_count
  FROM app.energy_calculations
  WHERE user_id = 'acct:004f_verify_a';

  IF v_count <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '非法输入路径新增了计算记录';
  END IF;
END
$assert_invalid_payloads$;

SELECT 'PASS' AS invalid_payloads_rejected_without_mutation;

RESET ROLE;
SELECT set_config('app.current_user_id', 'acct:004f_verify_b', true);
SET LOCAL ROLE diet_app;

DO $assert_cross_user_isolation$
BEGIN
  IF (SELECT COUNT(*) FROM app.energy_calculations
      WHERE user_id = 'acct:004f_verify_a') <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '004f跨用户能量计算隔离失败';
  END IF;
END
$assert_cross_user_isolation$;

SELECT 'PASS' AS cross_user_rls_isolation;

RESET ROLE;
ROLLBACK;

SELECT
  CASE WHEN
    (SELECT COUNT(*) FROM app.users
      WHERE user_id IN ('acct:004f_verify_a', 'acct:004f_verify_b')) = 0
    AND (SELECT COUNT(*) FROM app.energy_calculations
      WHERE user_id = 'acct:004f_verify_a') = 0
  THEN 'PASS' ELSE 'FAIL' END AS rollback_cleanup_status;

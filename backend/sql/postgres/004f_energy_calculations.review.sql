-- REVIEW ONLY: 004f 能量计算审计记录。
-- 前置：001-004e 已部署并验收。审核和云端沙箱通过前不得用于生产切换。

BEGIN;
SET LOCAL ROLE diet_owner;

CREATE TABLE app.energy_calculations (
  calculation_id varchar(128) PRIMARY KEY
    DEFAULT public.gen_random_uuid()::text,
  user_id varchar NOT NULL
    REFERENCES app.users(user_id) ON DELETE CASCADE,
  formula_id varchar(128) NOT NULL,
  formula_version varchar(64) NOT NULL,
  inputs jsonb NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  outputs jsonb NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT energy_calculations_formula_id_chk CHECK (
    char_length(btrim(formula_id)) BETWEEN 1 AND 128
  ),
  CONSTRAINT energy_calculations_formula_version_chk CHECK (
    char_length(btrim(formula_version)) BETWEEN 1 AND 64
  ),
  CONSTRAINT energy_calculations_inputs_object_chk CHECK (
    jsonb_typeof(inputs) = 'object'
  ),
  CONSTRAINT energy_calculations_assumptions_array_chk CHECK (
    jsonb_typeof(assumptions) = 'array'
  ),
  CONSTRAINT energy_calculations_outputs_object_chk CHECK (
    jsonb_typeof(outputs) = 'object'
  ),
  CONSTRAINT energy_calculations_source_refs_array_chk CHECK (
    jsonb_typeof(source_refs) = 'array'
  )
);

CREATE INDEX energy_calculations_user_time_idx
  ON app.energy_calculations (user_id, created_at DESC, calculation_id DESC);

ALTER TABLE app.energy_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.energy_calculations NO FORCE ROW LEVEL SECURITY;

CREATE POLICY energy_calculations_select_own
ON app.energy_calculations FOR SELECT TO diet_app
USING (user_id = app.current_user_id() AND app.current_user_is_active());

REVOKE ALL ON TABLE app.energy_calculations FROM PUBLIC, diet_app;
GRANT SELECT ON TABLE app.energy_calculations TO diet_app;

CREATE OR REPLACE FUNCTION app.record_current_user_energy_calculation(
  p_calculation jsonb,
  p_created_at timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
DECLARE
  v_user_id varchar := app.current_user_id();
  v_account_status varchar;
  v_formula_id varchar;
  v_formula_version varchar;
  v_inputs jsonb;
  v_assumptions jsonb;
  v_outputs jsonb;
  v_source_refs jsonb;
  v_created_at timestamptz := COALESCE(p_created_at, clock_timestamp());
  v_saved app.energy_calculations%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR btrim(v_user_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = '缺少当前用户身份';
  END IF;

  IF p_calculation IS NULL OR jsonb_typeof(p_calculation) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '能量计算记录格式不正确';
  END IF;

  IF octet_length(p_calculation::text) > 131072 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '能量计算记录过大';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_calculation) AS next_key(key_name)
    WHERE key_name NOT IN (
      'formulaId',
      'formulaVersion',
      'inputs',
      'assumptions',
      'outputs',
      'sourceRefs'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '能量计算记录包含未知字段';
  END IF;

  v_formula_id := NULLIF(btrim(p_calculation->>'formulaId'), '');
  v_formula_version := NULLIF(btrim(p_calculation->>'formulaVersion'), '');
  v_inputs := p_calculation->'inputs';
  v_assumptions := COALESCE(p_calculation->'assumptions', '[]'::jsonb);
  v_outputs := p_calculation->'outputs';
  v_source_refs := COALESCE(p_calculation->'sourceRefs', '[]'::jsonb);

  IF jsonb_typeof(p_calculation->'formulaId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_calculation->'formulaVersion') IS DISTINCT FROM 'string'
     OR v_formula_id IS NULL OR char_length(v_formula_id) > 128
     OR v_formula_version IS NULL OR char_length(v_formula_version) > 64
     OR jsonb_typeof(v_inputs) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_assumptions) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_outputs) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_source_refs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '能量计算记录字段不正确';
  END IF;

  IF jsonb_array_length(v_assumptions) > 32
     OR jsonb_array_length(v_source_refs) > 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '能量计算文本列表过长';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_assumptions) AS item(value)
    WHERE jsonb_typeof(value) <> 'string'
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_refs) AS item(value)
    WHERE jsonb_typeof(value) <> 'string'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '能量计算文本列表格式不正确';
  END IF;

  INSERT INTO app.users (user_id, status)
  VALUES (v_user_id, 'active')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT users.status
  INTO v_account_status
  FROM app.users AS users
  WHERE users.user_id = v_user_id
  FOR UPDATE;

  IF v_account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '当前用户不是active状态';
  END IF;

  INSERT INTO app.energy_calculations (
    user_id,
    formula_id,
    formula_version,
    inputs,
    assumptions,
    outputs,
    source_refs,
    created_at
  ) VALUES (
    v_user_id,
    v_formula_id,
    v_formula_version,
    v_inputs,
    v_assumptions,
    v_outputs,
    v_source_refs,
    v_created_at
  )
  RETURNING * INTO v_saved;

  RETURN jsonb_build_object(
    'calculationId', v_saved.calculation_id,
    'userId', v_saved.user_id,
    'formulaId', v_saved.formula_id,
    'formulaVersion', v_saved.formula_version,
    'inputs', v_saved.inputs,
    'assumptions', v_saved.assumptions,
    'outputs', v_saved.outputs,
    'sourceRefs', v_saved.source_refs,
    'createdAt', v_saved.created_at
  );
END;
$function$;

ALTER FUNCTION app.record_current_user_energy_calculation(jsonb, timestamptz)
OWNER TO diet_owner;
REVOKE ALL ON FUNCTION app.record_current_user_energy_calculation(jsonb, timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_current_user_energy_calculation(jsonb, timestamptz)
TO diet_app, diet_owner;

COMMENT ON TABLE app.energy_calculations IS
  '不可变的能量计算审计记录，保存标准化输入、公式版本、假设、输出与来源。';
COMMENT ON FUNCTION app.record_current_user_energy_calculation(jsonb, timestamptz) IS
  '为当前active用户追加一条经过形状与大小校验的能量计算审计记录。';

COMMIT;

const WEIGHT_FACTORS_TO_KG = {
  kg: 1,
  公斤: 1,
  千克: 1,
  jin: 0.5,
  斤: 0.5,
  g: 0.001,
  克: 0.001,
  lb: 0.45359237,
  lbs: 0.45359237,
  磅: 0.45359237,
};

const HEIGHT_FACTORS_TO_CM = {
  cm: 1,
  厘米: 1,
  m: 100,
  米: 100,
  in: 2.54,
  inch: 2.54,
  inches: 2.54,
  英寸: 2.54,
};

function normalizeUnit(unit) {
  return String(unit || '').trim().toLowerCase();
}

function normalizeMeasurement(value, unit, factors, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`${label}数值不正确`);
  const normalizedUnit = normalizeUnit(unit);
  const factor = factors[normalizedUnit];
  if (!factor) throw new Error(`不支持的${label}单位：${unit}`);
  return numeric * factor;
}

function normalizeWeightToKg(value, unit) {
  return normalizeMeasurement(value, unit, WEIGHT_FACTORS_TO_KG, '体重');
}

function normalizeHeightToCm(value, unit) {
  return normalizeMeasurement(value, unit, HEIGHT_FACTORS_TO_CM, '身高');
}

function normalizeAgeYears(value, unit = '岁') {
  const normalizedUnit = normalizeUnit(unit);
  if (!['岁', '岁数', 'year', 'years', 'y'].includes(normalizedUnit)) {
    throw new Error(`不支持的年龄单位：${unit}`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
    throw new Error('年龄数值不正确');
  }
  return numeric;
}

module.exports = {
  WEIGHT_FACTORS_TO_KG,
  HEIGHT_FACTORS_TO_CM,
  normalizeWeightToKg,
  normalizeHeightToCm,
  normalizeAgeYears,
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const {
  normalizeWeightToKg,
  normalizeHeightToCm,
  normalizeAgeYears,
} = require('./src/services/measurementNormalizationService');
const {
  calculateAdultEnergy,
  calculateAndRecordAdultEnergy,
} = require('./src/services/energyCalculationService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(action, pattern, message) {
  let matched = false;
  try { action(); } catch (err) { matched = pattern.test(err.message); }
  assert(matched, message);
}

async function main() {
  assert(normalizeWeightToKg(120, '斤') === 60, '斤没有正确换算为公斤');
  assert(Math.abs(normalizeWeightToKg(132.277, 'lbs') - 60) < 0.01, '磅没有正确换算为公斤');
  assert(normalizeWeightToKg(60000, 'g') === 60, '克没有正确换算为公斤');
  assert(normalizeHeightToCm(1.65, 'm') === 165, '米没有正确换算为厘米');
  assert(Math.abs(normalizeHeightToCm(64.9606, 'inch') - 165) < 0.01, '英寸没有正确换算为厘米');
  assert(normalizeAgeYears(22, '岁') === 22, '年龄单位没有正确识别');

  const calculation = calculateAdultEnergy({
    equationSex: 'female',
    ageYears: 22,
    heightCm: 165,
    weightKg: 60,
    activityLevel: 'light',
  });
  assert(calculation.outputs.estimatedBmrKcalPerDay === 1375.7, 'Schofield女性18-29岁BMR计算错误');
  assert(calculation.outputs.estimatedTeeKcalPerDay === 2063.5, 'BMR乘PAL的TEE计算错误');
  assert(calculation.inputs.pal === 1.5, '中国成人轻活动PAL值错误');
  assert(calculation.outputs.macronutrientRanges.carbohydrate.percentEnergy[0] === 50, '碳水供能范围错误');
  assert(calculation.outputs.dietaryFiberGramsPerDay[1] === 30, '膳食纤维范围错误');

  expectError(() => calculateAdultEnergy({
    equationSex: 'female', ageYears: 22, heightCm: 165, weightKg: 20, activityLevel: 'light',
  }), /明显异常/, '明显错误的身高体重组合仍进入了能量计算');
  expectError(() => calculateAdultEnergy({
    equationSex: 'unspecified', ageYears: 22, heightCm: 165, weightKg: 60, activityLevel: 'light',
  }), /不能由秘书猜测/, '系统自行猜测了能量方程性别参数');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-energy-calc-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:55555555-5555-4555-8555-555555555555';
  const recorded = await calculateAndRecordAdultEnergy(userId, calculation.inputs, {
    store,
    now: '2026-08-05T16:00:00+08:00',
  });
  assert(recorded.outputs.estimatedTeeKcalPerDay === 2063.5, '计算结果没有完整写入审计记录');
  assert(recorded.formulaVersion === '1.0.0', '公式版本没有写入审计记录');
  assert(recorded.sourceRefs.length === 2, '权威来源没有写入审计记录');
  assert(store.listEnergyCalculations(userId).length === 1, '计算审计记录数量错误');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 公斤、斤、克、磅、厘米、米、英寸和年龄单位正确标准化');
  console.log('✅ Schofield BMR × 中国成人PAL计算结果正确');
  console.log('✅ 国家标准宏量营养与膳食纤维范围正确');
  console.log('✅ 明显异常单位组合和缺失方程参数会被阻断');
  console.log('✅ 输入、假设、公式版本、结果和来源完整写入审计记录');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});

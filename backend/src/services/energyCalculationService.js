const userService = require('./userService');

const FORMULA_ID = 'FAO_WHO_UNU_SCHOFIELD_BMR_X_CHINA_PAL';
const FORMULA_VERSION = '1.0.0';
const SOURCE_REFS = [
  'https://www.fao.org/4/y5686e/y5686e.pdf#page=43',
  'https://www.nhc.gov.cn/ewebeditor/uploadfile/2017/10/20171017152901174.pdf',
];
const PAL_VALUES = { light: 1.5, moderate: 1.75, heavy: 2.0 };

const BMR_COEFFICIENTS = {
  male: {
    '18-29': { slope: 15.057, intercept: 692.2 },
    '30-59': { slope: 11.472, intercept: 873.1 },
    '60+': { slope: 11.711, intercept: 587.7 },
  },
  female: {
    '18-29': { slope: 14.818, intercept: 486.6 },
    '30-59': { slope: 8.126, intercept: 845.6 },
    '60+': { slope: 9.082, intercept: 658.5 },
  },
};

function ageBand(ageYears) {
  if (ageYears < 30) return '18-29';
  if (ageYears < 60) return '30-59';
  return '60+';
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('能量计算输入不能为空');
  if (!['male', 'female'].includes(input.equationSex)) {
    throw new Error('请选择用于能量方程的生理性别参数，不能由秘书猜测');
  }
  if (!Number.isInteger(input.ageYears) || input.ageYears < 18 || input.ageYears > 79) {
    throw new Error('当前成人能量公式仅支持18至79岁');
  }
  if (!Number.isFinite(input.weightKg) || input.weightKg < 10 || input.weightKg > 500) {
    throw new Error('体重必须是已经换算并确认的公斤数');
  }
  if (!Number.isFinite(input.heightCm) || input.heightCm < 120 || input.heightCm > 230) {
    throw new Error('身高必须是已经换算并确认的厘米数');
  }
  if (!Object.hasOwn(PAL_VALUES, input.activityLevel)) {
    throw new Error('身体活动水平必须明确为轻、中或重');
  }
  const bmi = input.weightKg / ((input.heightCm / 100) ** 2);
  if (bmi < 12 || bmi > 80) {
    throw new Error('身高和体重组合明显异常，请先核对数值及公斤、斤、厘米等单位');
  }
}

function calculateAdultEnergy(input) {
  validateInput(input);
  const band = ageBand(input.ageYears);
  const coefficient = BMR_COEFFICIENTS[input.equationSex][band];
  const bmr = coefficient.slope * input.weightKg + coefficient.intercept;
  const pal = PAL_VALUES[input.activityLevel];
  const tee = bmr * pal;
  const bmi = input.weightKg / ((input.heightCm / 100) ** 2);

  return {
    formulaId: FORMULA_ID,
    formulaVersion: FORMULA_VERSION,
    inputs: {
      equationSex: input.equationSex,
      ageYears: input.ageYears,
      heightCm: round(input.heightCm, 2),
      weightKg: round(input.weightKg, 3),
      activityLevel: input.activityLevel,
      pal,
    },
    assumptions: [
      '成人、非妊娠、非哺乳状态',
      '结果是基于群体方程的估算值，不是代谢测量值',
      '设备运动热量不直接等量加回每日饮食',
      '当前版本不自动设置减脂热量缺口',
    ],
    outputs: {
      bmi: round(bmi, 1),
      estimatedBmrKcalPerDay: round(bmr),
      estimatedTeeKcalPerDay: round(tee),
      macronutrientRanges: {
        carbohydrate: { percentEnergy: [50, 65], gramsPerDay: [round(tee * 0.5 / 4), round(tee * 0.65 / 4)] },
        fat: { percentEnergy: [20, 30], gramsPerDay: [round(tee * 0.2 / 9), round(tee * 0.3 / 9)] },
        protein: { percentEnergy: [10, 15], gramsPerDay: [round(tee * 0.1 / 4), round(tee * 0.15 / 4)] },
      },
      dietaryFiberGramsPerDay: [25, 30],
    },
    sourceRefs: SOURCE_REFS,
  };
}

async function calculateAndRecordAdultEnergy(userId, input, {
  store,
  now = new Date().toISOString(),
} = {}) {
  return await userService.recordEnergyCalculation(userId, calculateAdultEnergy(input), { store, now });
}

module.exports = {
  FORMULA_ID,
  FORMULA_VERSION,
  SOURCE_REFS,
  PAL_VALUES,
  BMR_COEFFICIENTS,
  calculateAdultEnergy,
  calculateAndRecordAdultEnergy,
};

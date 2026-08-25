const { parseExplicitBodyUnits } = require('./resolveBodyOnboarding');
const { findLastUserMessage, getMessageText } = require('../utils/messages');
const { calculateAdultEnergy } = require('../../services/energyCalculationService');

const CHANGE_TO_INPUT = {
  weight: 'weightKg',
  height: 'heightCm',
  age: 'ageYears',
  activity_level: 'activityLevel',
  equation_sex: 'equationSex',
};
const INPUT_LABELS = {
  weightKg: '当前体重（公斤或斤）',
  heightCm: '身高（厘米、米或英寸）',
  ageYears: '年龄',
  activityLevel: '现在的日常活动量',
  equationSex: '用于成人能量方程的生理性别参数',
};

function parseActivityLevel(text) {
  const normalized = String(text || '').toLowerCase();
  if (/(重体力|高活动|活动量大|heavy|very_active)/.test(normalized)) return 'heavy';
  if (/(中体力|中等活动|活动量中等|moderate|moderately_active)/.test(normalized)) return 'moderate';
  if (/(轻体力|轻活动|久坐|活动量小|light|sedentary|low_active)/.test(normalized)) return 'light';
  return null;
}

function parseEquationSex(text) {
  const normalized = String(text || '').toLowerCase();
  if (/(生理女性|女性|女|female)/.test(normalized)) return 'female';
  if (/(生理男性|男性|男|male)/.test(normalized)) return 'male';
  return null;
}

function extractEnergyInputs(text) {
  const body = parseExplicitBodyUnits(text);
  return {
    ...(body.ageYears != null ? { ageYears: body.ageYears } : {}),
    ...(body.heightCm != null ? { heightCm: body.heightCm } : {}),
    ...(body.currentWeightKg != null ? { weightKg: body.currentWeightKg } : {}),
    ...(parseActivityLevel(text) ? { activityLevel: parseActivityLevel(text) } : {}),
    ...(parseEquationSex(text) ? { equationSex: parseEquationSex(text) } : {}),
  };
}

function requiredChangedInputs(changes) {
  return [...new Set((changes || []).map((change) => CHANGE_TO_INPUT[change.field]).filter(Boolean))];
}

function missingInputs(input, required) {
  return required.filter((key) => input[key] === null || input[key] === undefined || input[key] === '');
}

function buildInputQuestion(missing) {
  const lines = missing.map((key, index) => `${index + 1}. ${INPUT_LABELS[key]}`);
  const activityHint = missing.includes('activityLevel')
    ? '\n\n活动量可以说“久坐或轻活动”“中等活动”“重体力或高活动”。'
    : '';
  return `为了重新计算准确，我只需要补充发生变化的项目：\n\n${lines.join('\n')}${activityHint}`;
}

function prepareFromConfirmedRequest(state) {
  const request = state.confirmedPlanRevisionRequest;
  if (!request) return {};
  if (request.changes.some((change) => change.field === 'health_status')) {
    return {
      messages: [{
        role: 'ai',
        content: '你提到身体或健康状态发生了变化，这一项不能直接套用普通饮食调整。我先暂停自动生成新版，接下来需要把具体症状和就医情况确认清楚，再判断适合怎样调整。',
      }],
      planRevisionPreparation: {
        status: 'risk_review_required',
        parentPlanId: request.parentPlanId,
        changes: request.changes,
      },
    };
  }

  const required = requiredChangedInputs(request.changes);
  const previousInputs = state.longTermContext?.latestEnergyCalculation?.inputs || {};
  if (!required.length) {
    return {
      messages: [{
        role: 'ai',
        content: '这次变化不需要重新填写身体数据，我会沿用之前已经确认的计算记录，接下来按新的作息、就餐条件和偏好生成完整方案。',
      }],
      planRevisionPreparation: {
        status: 'ready', parentPlanId: request.parentPlanId, changes: request.changes,
        needsRecalculation: false, energyInput: previousInputs,
      },
    };
  }

  // 用户在变化说明里已经给出的明确数值直接沿用，不让用户重复填写。
  const summaries = request.changes.map((change) => change.summary).join('；');
  const supplied = extractEnergyInputs(summaries);
  const energyInput = { ...previousInputs };
  // 已声明发生变化的字段不能继续拿旧值冒充新值。先让这些字段失效，
  // 再覆盖用户已经明确提供的新数值；其余未变化字段继续沿用。
  required.forEach((key) => { delete energyInput[key]; });
  Object.assign(energyInput, supplied);
  const missing = missingInputs(energyInput, required);
  if (!missing.length) {
    try {
      calculateAdultEnergy(energyInput);
      return {
        messages: [{ role: 'ai', content: '需要更新的计算数据已经齐了，我会用新数据重新估算，再生成完整的新版方案。' }],
        planRevisionPreparation: {
          status: 'ready', parentPlanId: request.parentPlanId, changes: request.changes,
          needsRecalculation: true, energyInput,
        },
      };
    } catch (err) {
      return {
        messages: [{ role: 'ai', content: `这组数据还不能直接用于计算：${err.message}。请先核对数值和单位。` }],
        planRevisionPreparation: {
          status: 'collect_energy_inputs', parentPlanId: request.parentPlanId,
          changes: request.changes, requiredInputs: required, energyInput,
        },
      };
    }
  }
  return {
    messages: [{ role: 'ai', content: buildInputQuestion(missing) }],
    planRevisionPreparation: {
      status: 'collect_energy_inputs', parentPlanId: request.parentPlanId,
      changes: request.changes, requiredInputs: required, energyInput,
    },
  };
}

function resolvePlanRevisionPreparation(state) {
  const preparation = state.planRevisionPreparation;
  if (!preparation || preparation.status !== 'collect_energy_inputs') return {};
  const userText = getMessageText(findLastUserMessage(state.messages)).trim();
  const energyInput = { ...preparation.energyInput, ...extractEnergyInputs(userText) };
  const missing = missingInputs(energyInput, preparation.requiredInputs);
  if (missing.length) {
    return {
      messages: [{ role: 'ai', content: buildInputQuestion(missing) }],
      planRevisionPreparation: { ...preparation, energyInput },
    };
  }
  try {
    calculateAdultEnergy(energyInput);
  } catch (err) {
    return {
      messages: [{ role: 'ai', content: `这组数据还不能直接用于计算：${err.message}。请核对数字和单位后再发我一次。` }],
      planRevisionPreparation: { ...preparation, energyInput },
    };
  }
  return {
    messages: [{ role: 'ai', content: '好，需要更新的数据已经齐了。我会用这组新数据重新估算，再生成完整的新版方案。' }],
    planRevisionPreparation: {
      ...preparation, status: 'ready', needsRecalculation: true, energyInput,
    },
  };
}

module.exports = {
  CHANGE_TO_INPUT,
  INPUT_LABELS,
  parseActivityLevel,
  parseEquationSex,
  extractEnergyInputs,
  requiredChangedInputs,
  missingInputs,
  buildInputQuestion,
  prepareFromConfirmedRequest,
  resolvePlanRevisionPreparation,
};

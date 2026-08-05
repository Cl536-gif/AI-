const { CYCLE_ONBOARDING_QUESTION } = require('../nodes/generatePlan');
const {
  mergeCycleProfile,
  cycleProfileNeedsMore,
  buildCycleRecordAck,
} = require('../nodes/resolveCycleOnboarding');

function main() {
  if (!CYCLE_ONBOARDING_QUESTION.includes('没有月经或暂时不方便提供')) {
    throw new Error('经期采集没有覆盖不适用或暂时无法提供的情况');
  }
  if (!CYCLE_ONBOARDING_QUESTION.includes('1.') || !CYCLE_ONBOARDING_QUESTION.includes('4.')) {
    throw new Error('经期资料没有用编号清晰列出');
  }
  const regular = mergeCycleProfile({}, {
    regularity: 'regular',
    startDates: ['7月28日'],
    typicalCycleDays: null,
    symptoms: ['经期前容易饿'],
  });
  if (cycleProfileNeedsMore(regular)) {
    throw new Error('规律周期且有开始日期仍被错误要求补充');
  }
  const irregularOneDate = mergeCycleProfile({}, {
    regularity: 'irregular',
    startDates: ['7月28日'],
    typicalCycleDays: null,
    symptoms: [],
  });
  if (!cycleProfileNeedsMore(irregularOneDate)) {
    throw new Error('不规律且只有一个日期时没有继续收集参考记录');
  }
  const ack = buildCycleRecordAck(regular);
  if (!ack.includes('周期记录') || !ack.includes('实际状态') || ack.includes('开始日期')) {
    throw new Error('经期回应没有保持简短，或向用户重复了后台记录');
  }

  console.log('✅ 长期方案后会单独发出经期采集问题');
  console.log('✅ 规律与不规律周期采用不同的数据充分性规则');
  console.log('✅ 用户侧回应保持简短，并以周期记录和实际状态为调整依据');
}

try {
  main();
} catch (err) {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
}

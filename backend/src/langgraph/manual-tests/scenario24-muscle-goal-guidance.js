const {
  MUSCLE_GOAL_GUIDANCE,
  isMuscleDefinitionGoal,
  getUndeliveredMuscleGoalGuidance,
} = require('../goalGuidance');
const { getFixedProductAnswer, WEARABLE_CALORIE_ANSWER } = require('../nodes/askNextQuestion');

function stateFor(goal, delivered = false) {
  return {
    slots: { goal: { value: goal, confirmed: true } },
    muscleGoalGuidanceDelivered: delivered,
  };
}

function main() {
  ['薄肌身材', '想要马甲线', '腹肌线条', '增肌', '紧致有力量感'].forEach((goal) => {
    if (!isMuscleDefinitionGoal(goal)) throw new Error(`没有识别肌肉类目标: ${goal}`);
  });
  if (isMuscleDefinitionGoal('更有精气神')) throw new Error('把普通状态目标误判为肌肉目标');
  if (!getUndeliveredMuscleGoalGuidance(stateFor('薄肌和马甲线'))) {
    throw new Error('首次确认肌肉目标后没有边界提示');
  }
  if (getUndeliveredMuscleGoalGuidance(stateFor('薄肌和马甲线', true))) {
    throw new Error('边界提示已经发送后仍然重复出现');
  }
  if (!MUSCLE_GOAL_GUIDANCE.includes('只支持手动打字')) {
    throw new Error('没有说明当前手表记录仅支持手动输入');
  }
  if (!MUSCLE_GOAL_GUIDANCE.includes('不会直接按手表数字等量补回')) {
    throw new Error('缺少手表消耗数据的安全边界');
  }
  if (getFixedProductAnswer('不会直接按手表数字等量补回，这是什么意思') !== WEARABLE_CALORIE_ANSWER) {
    throw new Error('手表消耗追问没有命中简短的固定解释');
  }

  console.log('✅ 薄肌/马甲线/腹肌/增肌等目标会触发一次性说明');
  console.log('✅ 当前只声明支持手动输入运动和手表数据');
  console.log('✅ 已发送后不重复，普通状态目标不误触发');
}

try {
  main();
} catch (err) {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
}

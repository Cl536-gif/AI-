const { generatePlan } = require('../nodes/generatePlan');
const { createInitialSlots } = require('../state');
const { detectFormatViolations } = require('../../services/formatGuard');

async function main() {
  const slots = createInitialSlots();
  slots.scene = { value: '食堂', confirmed: true };
  slots.cafeteriaMode = { value: '自己挑菜', confirmed: true };
  slots.taste = { value: '喜欢小炒肉，偏好辣味和甜味', confirmed: true };
  slots.budget = { value: '每顿20元左右', confirmed: true };
  slots.restrictions = { value: '没有忌口或已知过敏', confirmed: true };
  slots.goal = { value: '减脂', confirmed: true };
  slots.exercise = { value: '每周跑步两次，每次四十分钟', confirmed: true };

  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await generatePlan({
      messages: [{ role: 'human', content: '请给我今天这一餐的方案' }],
      slots,
      serviceTier: 'subscribed',
      pendingServiceAck: null,
      pushSchedule: '每周一和周四晚上八点',
      bodyOnboardingStatus: 'asked',
      cycleOnboardingStatus: null,
    });
    const plan = result.messages[0]?.content || '';
    const unsafeTypes = detectFormatViolations(plan)
      .map((item) => item.type)
      .filter((type) => [
        'unsupported_nutrition_equivalence',
        'inconsistent_portion_equivalence',
        'fixed_piece_count_for_mixed_dish',
        'robotic_dash',
        'english_letters',
      ].includes(type));
    if (unsafeTypes.length > 0) {
      throw new Error(`第${index + 1}版方案仍有问题 ${unsafeTypes.join(',')}: ${plan}`);
    }
    console.log(`✅ 第${index + 1}版真实方案通过营养表达、分量、标点和中文检查`);
  }
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

// 不调用模型的确定性回归测试：验证“食堂打饭方式”是独立后台字段，
// 食堂场景下必须先确认它，外卖场景不需要；对应问法使用固定模板。
const { createInitialSlots } = require('../state');
const { checkCompleteness } = require('../nodes/checkCompleteness');
const { askNextQuestion, CAFETERIA_MODE_QUESTION } = require('../nodes/askNextQuestion');

async function main() {
  const cafeteriaSlots = createInitialSlots();
  cafeteriaSlots.scene = { value: '食堂', confirmed: true };
  const cafeteriaCheck = checkCompleteness({ slots: cafeteriaSlots });
  if (cafeteriaCheck.nextSlotToAsk !== 'cafeteriaMode') {
    throw new Error(`食堂场景应先问cafeteriaMode，实际为${cafeteriaCheck.nextSlotToAsk}`);
  }

  const questionResult = await askNextQuestion({
    nextSlotToAsk: 'cafeteriaMode',
    slots: cafeteriaSlots,
  });
  if (questionResult.messages[0].content !== CAFETERIA_MODE_QUESTION) {
    throw new Error('食堂打饭方式没有使用确定性说明模板');
  }

  cafeteriaSlots.cafeteriaMode = { value: '固定套餐', confirmed: true };
  const afterModeCheck = checkCompleteness({ slots: cafeteriaSlots });
  if (afterModeCheck.nextSlotToAsk !== 'taste') {
    throw new Error(`确认打饭方式后应进入taste，实际为${afterModeCheck.nextSlotToAsk}`);
  }

  const deliverySlots = createInitialSlots();
  deliverySlots.scene = { value: '外卖', confirmed: true };
  const deliveryCheck = checkCompleteness({ slots: deliverySlots });
  if (deliveryCheck.nextSlotToAsk !== 'taste') {
    throw new Error(`外卖场景不应询问cafeteriaMode，实际为${deliveryCheck.nextSlotToAsk}`);
  }

  console.log('✅ 食堂先问打饭方式；确认后进入口味；外卖直接进入口味');
  console.log('✅ 固定话术:', CAFETERIA_MODE_QUESTION);
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

const { resolvePendingConfirmation, detectSupplementalConfirmation } = require('../nodes/resolvePendingConfirmation');

async function main() {
  const pending = {
    field: 'taste',
    oldValue: null,
    newValue: '喜欢小炒肉，可能偏好偏辣口味',
    reason: { type: 'dish_flavor_inference', dishName: '小炒肉', inferredTaste: '偏辣' },
    askedCount: 1,
  };

  const detected = detectSupplementalConfirmation(pending, '还有甜的');
  if (detected?.value !== '喜欢小炒肉，偏好辣味和甜味') {
    throw new Error(`补充口味合并错误: ${detected?.value}`);
  }

  const result = await resolvePendingConfirmation({
    messages: [{ role: 'human', content: '还有甜的' }],
    pendingConfirmation: pending,
    pendingConfirmationQueue: [],
    lastAskedSlot: 'taste',
  });
  if (result.slots?.taste?.value !== '喜欢小炒肉，偏好辣味和甜味') {
    throw new Error('确认问题中的新增口味没有保存');
  }
  if (!result.messages?.[0]?.content.includes('也喜欢甜味')) {
    throw new Error(`没有向用户复述新增信息: ${result.messages?.[0]?.content}`);
  }
  if (result.pendingConfirmation !== null) throw new Error('补充回答处理后仍卡在原确认问题');
  if (!result.skipCandidateFieldsOnce?.includes('taste')) throw new Error('没有阻止同轮重复抽取已合并字段');
  if (result.resumePreviousQuestion) throw new Error('当前口味已经回答完，却错误标记成需要返回前一个问题');

  const restriction = detectSupplementalConfirmation(
    { field: 'restrictions', newValue: '需要避开牛奶' },
    '另外还有花生'
  );
  if (restriction?.value !== '需要避开牛奶，还需避开花生') {
    throw new Error(`其它字段的补充逻辑没有生效: ${restriction?.value}`);
  }

  console.log('✅ “还有甜的”会确认原口味并合并新增口味');
  console.log('✅ 新增内容会被自然复述给用户');
  console.log('✅ 同轮不会重复抽取并再次卡进确认');
  console.log('✅ 当前问题完成后不会多发“返回前面问题”');
  console.log('✅ 补充机制可复用于忌口等其它字段');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

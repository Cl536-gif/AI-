const { conflictRouter, mergeExplicitAddition } = require('../nodes/conflictRouter');
const { mergeBothPendingValues } = require('../nodes/resolvePendingConfirmation');
const { createInitialSlots } = require('../state');

async function main() {
  const direct = mergeExplicitAddition('taste', '喜欢酸甜', '喜欢爆辣', '哦对还有我喜欢吃爆辣的');
  if (direct?.value !== '喜欢酸甜，也喜欢爆辣') {
    throw new Error(`明确补充被错误合并: ${direct?.value}`);
  }

  const slots = createInitialSlots();
  slots.taste = { value: '喜欢酸甜', confirmed: true };
  const routed = await conflictRouter({
    messages: [{ role: 'human', content: '哦对还有我喜欢吃爆辣的' }],
    slots,
    candidateSlots: { taste: '喜欢爆辣' },
    candidateConfirmationReasons: {},
    lastAskedSlot: 'budget',
    pendingConfirmation: null,
    pendingConfirmationQueue: [],
  });
  if (routed.pendingConfirmation) throw new Error('明确的并列补充仍被当成改口确认');
  if (routed.slots.taste?.value !== '喜欢酸甜，也喜欢爆辣') {
    throw new Error(`新增口味没有直接保存: ${routed.slots.taste?.value}`);
  }
  if (!routed.messages?.[0]?.content.includes('都喜欢')) {
    throw new Error('没有向用户复述合并后的含义');
  }

  const both = mergeBothPendingValues(
    { field: 'taste', oldValue: '喜欢酸甜', newValue: '喜欢爆辣' },
    '两个都是'
  );
  if (both?.value !== '喜欢酸甜，也喜欢爆辣') {
    throw new Error(`“两个都是”没有保留两个值: ${both?.value}`);
  }

  console.log('✅ “哦对还有”按新增信息直接合并，不再当作改口');
  console.log('✅ 合并结果会保存并向用户复述');
  console.log('✅ “两个都是”会保留新旧两个值');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

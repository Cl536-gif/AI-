const { normalizeTasteFromContext } = require('../nodes/extractSlots');
const { conflictRouter } = require('../nodes/conflictRouter');
const { askConfirmation } = require('../nodes/askConfirmation');
const { createInitialSlots } = require('../state');

async function main() {
  const normalized = normalizeTasteFromContext({
    userText: '小炒肉',
    lastAskedSlot: 'taste',
    extractedValue: null,
  });
  if (normalized.value !== '喜欢小炒肉，可能偏好偏辣口味') {
    throw new Error(`菜名规范化错误: ${normalized.value}`);
  }
  if (normalized.reason?.type !== 'dish_flavor_inference') {
    throw new Error('没有生成菜品口味待确认原因');
  }

  const routed = await conflictRouter({
    messages: [{ role: 'human', content: '小炒肉' }],
    slots: createInitialSlots(),
    candidateSlots: { taste: normalized.value },
    candidateConfirmationReasons: { taste: normalized.reason },
    lastAskedSlot: 'taste',
    pendingConfirmation: null,
    pendingConfirmationQueue: [],
  });
  if (routed.slots.taste) throw new Error('口味推断未经用户确认就被写入档案');
  if (routed.pendingConfirmation?.reason?.dishName !== '小炒肉') {
    throw new Error('小炒肉没有进入确认流程');
  }

  const reply = await askConfirmation({
    messages: [{ role: 'human', content: '小炒肉' }],
    pendingConfirmation: routed.pendingConfirmation,
  });
  const text = reply.messages.map((message) => message.content).join('\n');
  if (!text.includes('小炒肉通常会做得偏辣') || !text.includes('喜欢带辣的口味，对吗')) {
    throw new Error(`确认话术不符合预期: ${text}`);
  }

  console.log('✅ 具体菜名被识别为口味线索');
  console.log('✅ 小炒肉的偏辣推断先询问确认，不会直接落档');
  console.log('✅ 确认话术先回应菜名，再询问是否喜欢带辣口味');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

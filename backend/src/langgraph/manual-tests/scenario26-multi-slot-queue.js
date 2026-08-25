const { conflictRouter } = require('../nodes/conflictRouter');
const { createInitialSlots } = require('../state');

async function main() {
  const result = await conflictRouter({
    messages: [{ role: 'human', content: '我是校男大学生，平时点外卖，喜欢辣，一顿30元，目标减脂' }],
    slots: createInitialSlots(),
    candidateSlots: {
      scene: '外卖',
      taste: '喜欢辣',
      budget: '每顿30元',
      goal: '减脂',
    },
    lastAskedSlot: null,
    pendingConfirmation: null,
    pendingConfirmationQueue: [],
  });

  if (result.pendingConfirmation) throw new Error('清晰复合消息不应被拆成逐项确认');
  if ((result.pendingConfirmationQueue || []).length !== 0) {
    throw new Error(`清晰字段不应进入确认队列，实际数量: ${result.pendingConfirmationQueue.length}`);
  }
  for (const field of ['scene', 'taste', 'budget', 'goal']) {
    if (!result.slots?.[field]?.confirmed) throw new Error(`${field}没有直接确认保存`);
  }

  console.log('✅ 同一句里的多个清晰饮食维度会整体接收，不拆成逐项确认问卷');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

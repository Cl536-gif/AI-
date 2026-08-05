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

  if (!result.pendingConfirmation) throw new Error('复合消息的第一项没有进入确认流程');
  if ((result.pendingConfirmationQueue || []).length !== 3) {
    throw new Error(`复合消息其余字段没有逐项排队，实际数量: ${(result.pendingConfirmationQueue || []).length}`);
  }
  const queuedFields = result.pendingConfirmationQueue.map((item) => item.field).join(',');
  if (queuedFields !== 'taste,budget,goal') throw new Error(`确认队列顺序错误: ${queuedFields}`);

  console.log('✅ 同一句里的多个饮食维度都会被看见并按顺序进入确认队列');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

// 真实 LangGraph 回归：让抽取模型直接处理用户原话，验证不是只在手工
// 填 candidateSlots 的单元测试里成立。
const { graph } = require('../graph');
const { createInitialSlots } = require('../state');

async function main() {
  const slots = createInitialSlots();
  slots.scene = { value: '食堂', confirmed: true };
  slots.cafeteriaMode = { value: '自己挑菜', confirmed: true };
  slots.taste = { value: '喜欢酸甜', confirmed: true };
  slots.goal = { value: '减脂', confirmed: true };

  const state = await graph.invoke({
    messages: [{ role: 'human', content: '哦对还有我喜欢吃爆辣的' }],
    slots,
    candidateSlots: {},
    candidateConfirmationReasons: {},
    skipCandidateFieldsOnce: [],
    lastAskedSlot: 'budget',
    pendingConfirmation: null,
    pendingConfirmationQueue: [],
    retrieved: [],
  });

  const taste = state.slots.taste;
  if (!taste?.confirmed || !taste.value.includes('酸甜') || !taste.value.includes('爆辣')) {
    throw new Error(`真实图调用没有合并两种口味: ${JSON.stringify(taste)}`);
  }
  if (state.pendingConfirmation?.field === 'taste') {
    throw new Error(`真实图调用仍把新增口味当成改口: ${JSON.stringify(state.pendingConfirmation)}`);
  }
  const replies = state.messages
    .filter((message) => message.role !== 'human')
    .map((message) => String(message.content || ''))
    .join('\n');
  if (!replies.includes('都喜欢')) {
    throw new Error(`真实回复没有向用户复述新增信息: ${replies}`);
  }

  console.log(`✅ 真实抽取结果已合并: ${taste.value}`);
  console.log('✅ 真实 LangGraph 没有触发“改成爆辣吗”');
  console.log('✅ 回复中明确告诉用户两种口味都已记录');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

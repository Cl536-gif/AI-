const crypto = require('crypto');
const userService = require('./userService');
const { getUserStore } = require('../stores/userStoreProvider');
const { getMessageRole, getMessageText } = require('../langgraph/utils/messages');

const MEAL_ADVICE_EVIDENCE_REGEX = /(搭配|建议|分量|主食|蛋白质|蔬菜|加餐|早餐|午餐|晚餐|这一餐|这顿|换成)/;
const COLLECTION_ONLY_REGEX = /(告诉我|想问问你|再了解|还差|请提供|方便的话).*[？?]/;

function adviceKey(threadId, content) {
  const digest = crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 24);
  return `graph-advice:${threadId}:${digest}`;
}

function getCurrentTurnAssistantTexts(state) {
  const messages = state?.messages || [];
  const lastHumanIndex = messages.map((item) => getMessageRole(item)).lastIndexOf('human');
  if (lastHumanIndex < 0) return [];
  return messages.slice(lastHumanIndex + 1)
    .filter((item) => getMessageRole(item) !== 'human')
    .map((item) => getMessageText(item).trim())
    .filter(Boolean);
}

async function persistGraphAdvice(userId, threadId, state, {
  store = getUserStore(),
  now = new Date().toISOString(),
} = {}) {
  const serviceMode = state?.serviceTier === 'subscribed' ? 'long_term_onboarding' : 'free';
  const initialText = String(state?.initialMealPlanText || '').trim();
  const candidates = [];
  if (initialText) {
    candidates.push({ adviceType: 'initial_meal_plan', content: initialText });
  }
  getCurrentTurnAssistantTexts(state).forEach((content) => {
    if (content === initialText) return;
    if (!MEAL_ADVICE_EVIDENCE_REGEX.test(content) || COLLECTION_ONLY_REGEX.test(content)) return;
    candidates.push({ adviceType: 'ad_hoc_meal_advice', content });
  });

  const unique = [...new Map(candidates.map((item) => [item.content, item])).values()];
  const records = [];
  // 云端可能使用单连接池；顺序写入可避免同一请求内的多条建议
  // 互相争抢连接，同时保持建议记录顺序与对话顺序一致。
  for (const item of unique) {
    records.push(await userService.recordAdvice(userId, {
      ...item,
      serviceMode,
      threadId,
      idempotencyKey: adviceKey(threadId, item.content),
      metadata: {
        initialPlanDelivered: Boolean(state?.initialPlanDelivered),
        serviceTier: state?.serviceTier || 'free',
      },
      createdAt: now,
    }, { store }));
  }
  return {
    status: records.length ? 'recorded' : 'unchanged',
    records,
  };
}

module.exports = {
  MEAL_ADVICE_EVIDENCE_REGEX,
  getCurrentTurnAssistantTexts,
  persistGraphAdvice,
};

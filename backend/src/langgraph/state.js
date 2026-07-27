// LangGraph 状态图用的状态schema：把六项信息采集显式定义成状态变量，
// 不再依赖模型自己从原始对话历史里"回忆"当前采集到哪一步、各项值是什么。
const { Annotation } = require('@langchain/langgraph');

const SLOT_KEYS = ['scene', 'taste', 'budget', 'restrictions', 'goal', 'exercise'];

const SLOT_LABELS = {
  scene: '就餐场景（食堂/外卖）',
  taste: '口味偏好',
  budget: '预算（每顿）',
  restrictions: '忌口/过敏',
  goal: '身材目标',
  exercise: '是否运动',
};

function createEmptySlot() {
  return { value: null, confirmed: false };
}

function createInitialSlots() {
  const slots = {};
  SLOT_KEYS.forEach((key) => {
    slots[key] = createEmptySlot();
  });
  return slots;
}

const DietState = Annotation.Root({
  // 完整对话历史，跟现有 /api/chat-local 的 history 是同一类东西
  messages: Annotation({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  // 六项信息的当前状态，每项 { value, confirmed }
  slots: Annotation({
    reducer: (left, right) => ({ ...left, ...right }),
    default: createInitialSlots,
  }),

  // extractSlots 节点这一轮抽取出的候选值（还没写入 slots，
  // 要经过 conflictRouter 判断没有冲突才能真正落地）。
  // 每轮都会被覆盖，不需要累积历史。
  candidateSlots: Annotation({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),

  // 上一轮 AI 主动问的是六项里的哪一项，帮助下一轮解读简短/模糊回答
  // （比如问完预算后用户只回"20"，靠这个字段才知道该往预算上理解，
  // 不用再像纯提示词那样，靠模型自己从上下文里猜"现在问到哪了"）
  lastAskedSlot: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 疑似改口/冲突时的待确认信息，非空时表示上一轮已经问了确认问题，
  // 这一轮要优先当作对这个确认问题的回答来解析。
  // 形状：{ field, oldValue, newValue }
  pendingConfirmation: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 本地知识库检索到的片段，供 generatePlan 节点拼提示词用
  retrieved: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),
});

module.exports = {
  DietState,
  SLOT_KEYS,
  SLOT_LABELS,
  createEmptySlot,
  createInitialSlots,
};

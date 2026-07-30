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

  // checkCompleteness 节点的判断结果：六项是否已经全部确认
  isComplete: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
  }),

  // checkCompleteness 判定还没收集完时，接下来该问六项里的哪一项
  // （SLOT_KEYS 顺序里第一个还没确认的），交给 askNextQuestion 节点
  // 生成实际问出来的自然语言问题。全部确认完时是 null。
  nextSlotToAsk: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 六项信息采集完毕、generatePlan出方案之前，服务边界问询的最终结论：
  // null（还没问/还没定）| 'free'（免费临时问答）| 'subscribed'（开通了
  // 定期推送服务）。只有这一项不是null时才会放行到generatePlan。
  serviceTier: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 服务边界问题问出去之后、等用户回答期间的暂存状态，形状：
  // { stage: 'choice' | 'schedule', askedCount }。stage是'choice'时在等
  // 用户选免费还是订阅；用户选订阅后转成'schedule'，等用户设定推送
  // 时间。两个阶段的askedCount分开计数，互不影响。resolved（拿到明确
  // 结论或者含糊次数用完默认按免费处理）之后清空为null。
  pendingServiceChoice: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 用户开通推送服务后自己设定的提醒时间/频率偏好，自由文本，不做
  // 格式校验。serviceTier不是'subscribed'时为null。
  pushSchedule: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 一次性标记：本轮resolveServiceChoice是不是刚把pushSchedule写入
  // （用户刚完成推送时间设定）。只在resolveServiceChoice设为true那
  // 一轮生效，generatePlan读取后必须显式把它重置回false，否则后续
  // 每一轮（生成方案后還会一直复用同一个serviceTier继续走generatePlan）
  // 都会被误判成"刚设定"。
  justSetPushSchedule: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

module.exports = {
  DietState,
  SLOT_KEYS,
  SLOT_LABELS,
  createEmptySlot,
  createInitialSlots,
};

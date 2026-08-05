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
  cafeteriaMode: '食堂打饭方式（自己挑菜/固定套餐）',
};

// 六项核心信息之外，额外保存会直接影响方案落地方式的后台信息。
// cafeteriaMode 不参与“六项复述”，但食堂场景下必须确认后才能出方案。
const TRACKED_SLOT_KEYS = [...SLOT_KEYS, 'cafeteriaMode'];

function createEmptySlot() {
  return { value: null, confirmed: false };
}

function createInitialSlots() {
  const slots = {};
  TRACKED_SLOT_KEYS.forEach((key) => {
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

  // 确定性菜品识别等规则为候选值附带的确认原因。它和 candidateSlots
  // 一样只保留当前轮，用于让确认问题准确解释“为什么这样理解”。
  candidateConfirmationReasons: Annotation({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),

  // 用户在确认问题里可能一边确认，一边补充同一字段的新内容。解析节点
  // 已经合并并保存后，本轮 extractSlots 仍会再次看到同一条用户消息。
  // 用这个一次性字段避免同一信息被二次抽取、重新触发确认；其它字段仍
  // 照常抽取，保证用户一句话回答多个维度时不会丢信息。
  skipCandidateFieldsOnce: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),

  // 本轮入口已经发送过情绪支持。后续提问节点据此避免再次重复共情，
  // 并在问题前加一句简短的“是否愿意开始”过渡；使用后立即重置。
  emotionalSupportDeliveredThisTurn: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
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

  // 同一条用户消息可能同时提供多个尚未询问的字段。第一个进入确认流程，
  // 其余按顺序排队，避免只处理第一个后把其它信息丢掉。
  pendingConfirmationQueue: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),

  // 插入确认问题处理完以后，回到此前尚未回答的问题时使用一次性的自然
  // 过渡消息，随后立即重置。
  resumePreviousQuestion: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
  }),

  // 本地知识库检索到的片段，供 generatePlan 节点拼提示词用
  retrieved: Annotation({
    reducer: (_left, right) => right,
    default: () => [],
  }),

  // 第一版方案是否已经发出。之后用户简单回应或继续追问时，不能再次
  // 复述全部档案、重复生成第一版方案。
  initialPlanDelivered: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
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

  // 一次性暂存：用户刚设定完推送时间那一轮，resolveServiceChoice用
  // 确定性模板拼好的"已帮你设置好"这句话，不经过LLM生成（避免让
  // generatePlan的LLM调用同时兼顾"呼应订阅+复述六项+给方案+守格式"
  // 四件事，压力太大时观察到过牺牲方案内容去保格式的情况）。
  // generatePlan读到后原样拼进最终回复最前面，读取后必须显式重置回
  // null，否则后续每一轮（生成方案后還会一直复用同一个serviceTier
  // 继续走generatePlan）都会被误判成"刚设定"、重复拼接这句话。
  pendingServiceAck: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 长期方案第一版发出后，先采集后台计算所需的基础身体数据，再进入
  // 经期自愿采集。required: 年龄、身高、当前体重；其余信息可选。
  bodyOnboardingStatus: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  pendingBodyOnboarding: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  bodyProfile: Annotation({
    reducer: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    default: () => ({}),
  }),

  // 长期方案的经期信息自愿采集状态。第一版方案发出后进入 asked，等待
  // 用户提供大概信息或明确跳过；完成后不再重复询问。
  cycleOnboardingStatus: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  pendingCycleOnboarding: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 当前仅保存用户原话，避免从模糊描述中自行推算周期或医学结论。
  menstrualProfile: Annotation({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // 肌肉/线条类目标的饮食与运动边界只在首次确认时说明一次，避免后续
  // 每轮重复相同提醒。
  muscleGoalGuidanceDelivered: Annotation({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

module.exports = {
  DietState,
  SLOT_KEYS,
  SLOT_LABELS,
  TRACKED_SLOT_KEYS,
  createEmptySlot,
  createInitialSlots,
};

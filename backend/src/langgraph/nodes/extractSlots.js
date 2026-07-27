// 信息抽取节点：判断用户这一轮消息里，六项信息各自有没有新的候选值。
// 这是其他节点（冲突检测、完整性判断、出方案）的基础——只有先把
// "这一轮用户到底说了什么"结构化抽取出来，后面的状态更新/路由才有依据。
const { z } = require('zod');
const { model } = require('../model');
const { SLOT_KEYS, SLOT_LABELS } = require('../state');
const { getMessageText, findLastUserMessage } = require('../utils/messages');

const extractionSchema = z.object({
  scene: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"就餐场景"信息（比如"食堂""外卖"这类原始表述）。' +
        '如果这一轮消息完全没涉及这个信息，填 null，不要凭空猜测或沿用旧值。'
    ),
  taste: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"口味偏好"信息（比如"麻辣""清淡"这类原始表述）。' +
        '如果这一轮消息完全没涉及这个信息，填 null。'
    ),
  budget: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"预算"信息，尽量整理成"每顿XX元"这种带颗粒度的' +
        '表述（比如结合上下文判断用户说的"20"是每顿预算，就填"每顿20元左右"）。' +
        '如果这一轮消息完全没涉及这个信息，填 null。'
    ),
  restrictions: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"忌口/过敏"信息，只记录"不能吃/要避开"的食物或' +
        '反应，不是"喜欢吃"的食物。如果这一轮消息完全没涉及这个信息，填 null。'
    ),
  goal: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"身材目标"信息，优先记录结果导向的表述（比如' +
        '"穿衣更好看""拍照更立体"），用户提到具体身体部位时也如实记录原话，不要' +
        '自己改写成别的说法。如果这一轮消息完全没涉及这个信息，填 null。'
    ),
  exercise: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"是否运动"信息。如果这一轮消息完全没涉及这个' +
        '信息，填 null。'
    ),
});

const structuredModel = model.withStructuredOutput(extractionSchema, {
  name: 'extract_slots',
});

function formatKnownSlots(slots) {
  const known = SLOT_KEYS.filter((key) => slots[key] && slots[key].value).map((key) => {
    const slot = slots[key];
    return `${SLOT_LABELS[key]}: ${slot.value}${slot.confirmed ? '（已确认）' : '（未确认，待确认中）'}`;
  });
  return known.length > 0 ? known.join('\n') : '（目前还没有任何一项信息）';
}

/**
 * 信息抽取节点。输入当前状态，输出这一轮的候选值 candidateSlots，
 * 不直接修改 slots 本身——是否真的落地由后面的 conflictRouter 决定
 * （已确认的值如果这轮抽出了不同的候选值，要走确认流程，不能直接覆盖）。
 */
async function extractSlots(state) {
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);

  if (!userText.trim()) {
    return { candidateSlots: {} };
  }

  const currentFocusLabel = state.lastAskedSlot
    ? SLOT_LABELS[state.lastAskedSlot]
    : '（上一轮没有主动问具体的哪一项）';

  const prompt = [
    {
      role: 'system',
      content:
        '你是一个信息抽取助手，任务是从用户这一轮说的话里，判断六项饮食信息' +
        '（就餐场景、口味偏好、预算、忌口/过敏、身材目标、是否运动）里，哪几项' +
        '这一轮有新的信息。只抽取"这一轮用户实际提供了什么"，不要替用户编造，' +
        '也不要把已经确认过的旧信息重复填一遍（除非用户这一轮明确又提了一次）。\n\n' +
        `目前已经掌握的信息：\n${formatKnownSlots(state.slots)}\n\n` +
        `上一轮AI主动问的是：${currentFocusLabel}——如果这一轮用户的回答很简短` +
        '或者有歧义（比如只回一个数字、一个词），优先结合"上一轮问的是什么"来' +
        '判断这句话对应六项里的哪一项，不要机械地要求逐字匹配。',
    },
    { role: 'human', content: userText },
  ];

  const extracted = await structuredModel.invoke(prompt);

  const candidateSlots = {};
  SLOT_KEYS.forEach((key) => {
    if (extracted[key]) {
      candidateSlots[key] = extracted[key];
    }
  });

  return { candidateSlots };
}

module.exports = { extractSlots, extractionSchema };

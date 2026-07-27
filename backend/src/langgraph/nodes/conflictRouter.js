// 冲突检测节点：extractSlots 抽出来的候选值，跟已确认的旧值做比对，
// 判断到底是"真的改口/纠正"、"只是换个说法但意思一样"，还是"顺嘴提到、
// 不是真的在回答这一项"。只有第一种才需要触发确认流程（对应"用户改口时
// AI直接沿用旧信息"这个bug）——后两种都要正常处理掉，不能让这个节点
// 太敏感，把无关的顺嘴提及也当成需要确认的冲突，制造新的啰嗦问题。
const { z } = require('zod');
const { model } = require('../model');
const { SLOT_KEYS, SLOT_LABELS } = require('../state');
const { getMessageText, findLastUserMessage } = require('../utils/messages');

const ClassificationSchema = z.object({
  classification: z
    .enum(['same_meaning', 'correction', 'incidental_mention'])
    .describe(
      '判断新候选值和旧的已确认值之间的关系。' +
        'same_meaning：只是换了个说法或补充了细节，实际还是同一件事，不算改口。' +
        'correction：用户确实是在改口/纠正这一项，新旧值真的互相矛盾。' +
        'incidental_mention：用户只是在回答别的问题时顺嘴提到了这个词、这个词只是' +
        '句子里的次要修饰成分，并不是用户主动想更新或纠正这一项。'
    ),
  reason: z.string().describe('用一句话简单说明为什么这么判断，方便调试排查。'),
});

const structuredClassifier = model.withStructuredOutput(ClassificationSchema, {
  name: 'classify_conflict',
});

async function classifyPotentialConflict({ slotLabel, oldValue, newValue, focusLabel, userText }) {
  const prompt = [
    {
      role: 'system',
      content:
        `用户此前已经明确确认过"${slotLabel}"这一项是"${oldValue}"。这一轮消息里，` +
        `抽取到了一个不一样的候选值"${newValue}"。这一轮AI实际问的是"${focusLabel}"。\n\n` +
        '请判断这个新候选值和旧值之间的关系。关键判断标准不是"这一轮AI问的是不是' +
        `这一项"，而是"用户是不是在主动、明确地断言/修正${slotLabel}这件事本身"。\n\n` +
        '两种容易混淆的情况，注意区分：\n' +
        '1. 用户带着"哦对了""其实是""不是……是……""我刚才说错了"这类自我修正/补充' +
        '的语气，主动把这一项的内容重新说了一遍——哪怕这一轮AI问的是别的项，这也' +
        '应该判成 correction，不能因为"跟当前问题无关"就归成 incidental_mention。\n' +
        '2. 这个词只是用户回答别的问题时，句子里一个次要的修饰/背景成分，用户的' +
        '注意力完全在回答别的问题上，没有表现出"我要更新/纠正这一项"的意图——' +
        '这种才是 incidental_mention。',
    },
    { role: 'human', content: userText },
  ];
  const result = await structuredClassifier.invoke(prompt);
  return result;
}

/**
 * 冲突检测节点：
 * - 还没确认过的项：候选值直接落地并标记为已确认（相当于第一次回答）。
 * - 已确认过、候选值跟旧值字面完全一致：跳过，不调用模型（省一次调用）。
 * - 已确认过、候选值跟旧值字面不同：调用分类模型判断。
 *   - same_meaning：更新措辞但依然算已确认，不触发确认流程。
 *   - correction：记录进 pendingConfirmation，交给 askConfirmation 生成确认问题。
 *   - incidental_mention：丢弃这个候选值，这一项保持原样不变。
 * 一轮里最多只处理一个待确认冲突（万一同时出现多个，先问排在前面的那个，
 * 其余的候选值这一轮先丢弃，不强行一次性堆多个确认问题）。
 */
async function conflictRouter(state) {
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);
  const focusLabel = state.lastAskedSlot ? SLOT_LABELS[state.lastAskedSlot] : '（没有明确针对某一项）';

  const slotUpdates = {};
  let firstConflict = null;

  for (const key of SLOT_KEYS) {
    const candidate = state.candidateSlots?.[key];
    if (!candidate) continue;

    const slot = state.slots[key] || { value: null, confirmed: false };

    if (!slot.confirmed) {
      slotUpdates[key] = { value: candidate, confirmed: true };
      continue;
    }

    if (candidate === slot.value) {
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { classification, reason } = await classifyPotentialConflict({
      slotLabel: SLOT_LABELS[key],
      oldValue: slot.value,
      newValue: candidate,
      focusLabel,
      userText,
    });

    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[conflictRouter] ${key}: ${slot.value} -> ${candidate} => ${classification} (${reason})`);
    }

    if (classification === 'same_meaning') {
      slotUpdates[key] = { value: candidate, confirmed: true };
    } else if (classification === 'correction' && !firstConflict) {
      firstConflict = { field: key, oldValue: slot.value, newValue: candidate };
    }
    // incidental_mention：什么都不做，丢弃这个候选值
  }

  return {
    slots: slotUpdates,
    candidateSlots: {},
    pendingConfirmation: firstConflict,
  };
}

module.exports = { conflictRouter, classifyPotentialConflict };

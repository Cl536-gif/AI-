// 冲突检测节点：extractSlots 抽出来的候选值，跟已确认的旧值做比对，
// 判断到底是"真的改口/纠正"、"只是换个说法但意思一样"，还是"顺嘴提到、
// 不是真的在回答这一项"。只有第一种才需要触发确认流程（对应"用户改口时
// AI直接沿用旧信息"这个bug）——后两种都要正常处理掉，不能让这个节点
// 太敏感，把无关的顺嘴提及也当成需要确认的冲突，制造新的啰嗦问题。
const { z } = require('zod');
const { classifierModel } = require('../model');
const { SLOT_LABELS, TRACKED_SLOT_KEYS } = require('../state');
const { getMessageText, findLastUserMessage } = require('../utils/messages');
const { recognizeDish } = require('../../data/commonDishCatalog');

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

const structuredClassifier = classifierModel.withStructuredOutput(ClassificationSchema, {
  name: 'classify_conflict',
});

const REACTION_ONLY_REGEX = /^(吃(了|完|后)?会?)?(拉肚子|腹泻|腹胀|肚子疼|恶心|呕吐|起疹子|皮肤发痒|发痒|不舒服)[。！!～~]?$/;

function mergeRestrictionReaction(oldValue, newValue, userText) {
  if (!oldValue || !newValue || !REACTION_ONLY_REGEX.test(userText.trim())) return null;
  const reaction = newValue.replace(/^吃(了|完|后)?会?/, '');
  if (oldValue.includes(reaction)) return oldValue;
  return `${oldValue}，吃后会${reaction}`;
}

const EXPLICIT_ADDITION_REGEX = /(?:哦对[，,。\s]*)?(?:还有|还喜欢|也喜欢|另外(?:还有)?|再加上|而且|同时)/;

function stripPreferencePrefix(value) {
  return String(value || '')
    .replace(/^(?:我)?(?:还|也)?(?:喜欢吃|喜欢|爱吃|偏好)/, '')
    .replace(/[，,。！？!?；;：:～~\s]+$/g, '')
    .replace(/的$/, '')
    .trim();
}

// 用户已经确认过某一项后，又主动说“哦对还有……”“另外也……”时，
// 语义是并列补充而不是替换。这里在冲突分类模型之前做确定性合并，避免
// “酸甜 + 还有爆辣”被误问成“现在是想改成爆辣吗”。
function mergeExplicitAddition(field, oldValue, newValue, userText) {
  if (!EXPLICIT_ADDITION_REGEX.test(String(userText || ''))) return null;
  const addition = stripPreferencePrefix(newValue);
  if (!addition || oldValue.includes(addition)) return null;

  switch (field) {
    case 'taste':
      {
        const dish = recognizeDish(addition);
        if (dish?.tasteInference) {
          return {
            value: `${oldValue}，也喜欢${dish.canonicalName}，可能偏好${dish.tasteInference.value}口味`,
            acknowledgement: null,
            requiresConfirmation: true,
            reason: {
              type: 'dish_collection_inference',
              dishName: dish.canonicalName,
              inferredTaste: dish.tasteInference.value,
              existingPreference: oldValue,
            },
          };
        }
      }
      return {
        value: `${oldValue}，也喜欢${addition}`,
        acknowledgement: `记下啦，你之前说的口味和${addition}都喜欢。`,
      };
    case 'restrictions':
      return {
        value: `${oldValue}，还需避开${addition}`,
        acknowledgement: `记下啦，除了之前说的，${addition}也需要避开。`,
      };
    case 'goal':
      return {
        value: `${oldValue}，也希望${addition}`,
        acknowledgement: `记下啦，${addition}也是你的目标之一。`,
      };
    case 'exercise':
      return {
        value: `${oldValue}，另外${addition}`,
        acknowledgement: `记下啦，你的运动情况还包括${addition}。`,
      };
    case 'scene':
      return {
        value: `${oldValue}，也会${addition}`,
        acknowledgement: `记下啦，这两种就餐场景你都会遇到。`,
      };
    case 'budget':
      return {
        value: `${oldValue}，另外${addition}`,
        acknowledgement: `记下啦，预算方面还要加上${addition}。`,
      };
    case 'cafeteriaMode':
      return {
        value: `${oldValue}，也有${addition}`,
        acknowledgement: `记下啦，你们食堂这两种打饭方式都有。`,
      };
    default:
      return null;
  }
}

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
 *
 * 重要：如果这一轮进来时已经有一个待确认事项（state.pendingConfirmation
 * 非空，说明上一轮的确认还没解决），这一轮不再叠加产生第二个待确认——
 * 新出现的 correction 候选值直接丢弃（等旧的确认解决后，用户如果还想
 * 改，之后自然还有机会再说一次），避免用户同时面对两个待澄清的问题。
 * 但除了"新冲突"这一件事之外，其余能正常落地的更新（第一次回答、
 * same_meaning）依然照常处理，不能因为有旧确认在等，就连这些无冲突的
 * 新信息也一起吞掉。
 *
 * 同样重要：只有这一轮真的产生了新冲突时，才会在返回值里带上
 * pendingConfirmation 这个字段；没有新冲突时完全不碰这个字段（既不
 * 设置也不清空），让它保持调用前的原样——不然会把 resolvePendingConfirmation
 * 那边还没解决、特意保留下来的旧待确认事项，被这里误当作"这一轮没有
 * 冲突"而覆盖成 null，导致那个悬而未决的问题凭空消失。
 *
 * 结构性安全防线（对应真实复现过的漏洞：extractSlots 一旦编造/误判出
 * 候选值，只要对应字段之前"未确认过"，就会被下面这条逻辑无条件标记成
 * confirmed:true，完全绕过用户确认——"自选"触发五项瞎猜的那次复现，
 * 五个字段就是这样被瞎猜之后直接锁定成已确认状态的）：
 * 是否可以跳过确认、直接自动落地，判断标准不是"这个字段是不是第一次
 * 填"，而是"这个字段是不是用户这一轮正面回答的那一项"——也就是
 * state.lastAskedSlot。只有 candidate 对应的字段正好是 AI 这一轮主动
 * 问的那个字段时，才认为风险较低、可以直接自动确认；除此之外，任何
 * "意外"出现在 candidateSlots 里、AI 根本没问的字段，哪怕是第一次填、
 * 之前完全没有旧值，也必须走跟"改口"完全一样的确认流程，不能因为
 * "反正是第一次、没有旧值可覆盖"就放松警惕——这正是漏洞发生的地方。
 * 这条判断是纯代码逻辑，不依赖模型自己判断"这次是不是在瞎猜"，也不
 * 依赖已经发现过的具体编造模式（比如"自选"这个词本身），对任何未来
 * 还没遇到过的新编造模式同样有效。
 */
async function conflictRouter(state) {
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);
  const focusLabel = state.lastAskedSlot ? SLOT_LABELS[state.lastAskedSlot] : '（没有明确针对某一项）';
  const hasExistingPending = Boolean(state.pendingConfirmation);

  const slotUpdates = {};
  const acknowledgementMessages = [];
  let firstConflict = null;
  const pendingQueue = [...(state.pendingConfirmationQueue || [])];

  function queueConflict(conflict) {
    if (!pendingQueue.some((item) => item.field === conflict.field && item.newValue === conflict.newValue)) {
      pendingQueue.push(conflict);
    }
  }

  for (const key of TRACKED_SLOT_KEYS) {
    const candidate = state.candidateSlots?.[key];
    if (!candidate) continue;

    const slot = state.slots[key] || { value: null, confirmed: false };
    const isFocusSlot = key === state.lastAskedSlot;
    const confirmationReason = state.candidateConfirmationReasons?.[key] || null;

    if (!slot.confirmed) {
      const canSafelyCaptureCafeteriaMode =
        key === 'cafeteriaMode' &&
        ((state.slots.scene?.confirmed && state.slots.scene.value?.includes('食堂')) ||
          (!state.slots.scene?.confirmed &&
            state.lastAskedSlot === 'scene' &&
            state.candidateSlots?.scene?.includes('食堂')));
      if ((isFocusSlot || canSafelyCaptureCafeteriaMode) && !confirmationReason) {
        // AI这一轮主动问的就是这一项，用户是在正面回答问题，风险较低，
        // 按原逻辑直接确认。
        slotUpdates[key] = { value: candidate, confirmed: true };
      } else if (!firstConflict && !hasExistingPending) {
        // 意外字段：AI这一轮没有问这一项，但 candidateSlots 里却冒出来了。
        // 哪怕是"第一次填、没有旧值"，也不能无脑自动确认——统一走确认
        // 流程，oldValue 传 null 表示这不是真的"改口"，是首次出现的
        // 意外候选值。
        if (process.env.LANGGRAPH_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`[conflictRouter] ${key} 是意外字段（非lastAskedSlot）且首次出现候选值 "${candidate}"，转入确认流程而不是自动确认`);
        }
        firstConflict = { field: key, oldValue: null, newValue: candidate, reason: confirmationReason };
      } else {
        queueConflict({ field: key, oldValue: null, newValue: candidate, reason: confirmationReason });
      }
      continue;
    }

    if (candidate === slot.value) {
      continue;
    }

    const explicitAddition = mergeExplicitAddition(key, slot.value, candidate, userText);
    if (explicitAddition) {
      if (explicitAddition.requiresConfirmation) {
        const conflict = {
          field: key,
          oldValue: slot.value,
          newValue: explicitAddition.value,
          reason: explicitAddition.reason,
        };
        if (!firstConflict && !hasExistingPending) firstConflict = conflict;
        else queueConflict(conflict);
      } else {
        slotUpdates[key] = { value: explicitAddition.value, confirmed: true };
        acknowledgementMessages.push({ role: 'ai', content: explicitAddition.acknowledgement });
      }
      continue;
    }

    if (key === 'restrictions') {
      const mergedRestriction = mergeRestrictionReaction(slot.value, candidate, userText);
      if (mergedRestriction) {
        slotUpdates[key] = { value: mergedRestriction, confirmed: true };
        continue;
      }
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
    } else if (classification === 'correction') {
      const conflict = { field: key, oldValue: slot.value, newValue: candidate };
      if (!firstConflict && !hasExistingPending) firstConflict = conflict;
      else queueConflict(conflict);
    }
    // incidental_mention：什么都不做，丢弃这个候选值
    // correction 但 hasExistingPending 为真：同样丢弃，避免叠加第二个待确认
  }

  const result = {
    slots: slotUpdates,
    candidateSlots: {},
    candidateConfirmationReasons: {},
  };
  if (acknowledgementMessages.length > 0) result.messages = acknowledgementMessages;

  if (firstConflict) {
    result.pendingConfirmation = firstConflict;
  }
  if (pendingQueue.length !== (state.pendingConfirmationQueue || []).length) {
    result.pendingConfirmationQueue = pendingQueue;
  }

  return result;
}

module.exports = {
  conflictRouter,
  classifyPotentialConflict,
  mergeRestrictionReaction,
  mergeExplicitAddition,
};

// 待确认解析节点：只在 state.pendingConfirmation 非空时才会被路由到这里
// （见 graph.js 的入口路由）。这一轮用户的回复要优先当作"对上一轮确认问题
// 的回答"来解析：同意就把新值真正落地，不同意就维持旧值，两种情况都清空
// pendingConfirmation；如果回答本身没讲清楚，保留 pendingConfirmation，
// 让 askConfirmation 再问一次，不能不清不楚地就当作已经解决了。
//
// MAX_ASK_COUNT：真实测试发现，如果用户一直不正面回应确认问题、只是
// 继续正常回答别的问题，这个确认会无限期卡住——routeAfterConflictCheck
// 每一轮都会送回askConfirmation原地重复问同一句问题，还会连带卡住
// lastAskedSlot 的推进，导致后续所有"意外字段"都被反复丢弃，表现跟
// 死锁几乎一样。问过 MAX_ASK_COUNT 次还是没能得到明确回应，就不再
// 追问，按"放弃这次确认"处理（跟明确否认时一样恢复原状），把主动权
// 还给对话，让这一轮的真实内容能正常往下走。
const { z } = require('zod');
const { classifierModel } = require('../model');
const { getMessageText, findLastUserMessage } = require('../utils/messages');

const MAX_ASK_COUNT = 2;

const ResolutionSchema = z.object({
  resolution: z
    .enum(['confirmed', 'rejected', 'unclear'])
    .describe(
      'confirmed：用户同意了这次改口/纠正。' +
        'rejected：用户否认了，还是维持原来的值。' +
        'unclear：用户的回答没有明确回应这个确认问题（比如答非所问），需要再问一次。'
    ),
});

const structuredResolver = classifierModel.withStructuredOutput(ResolutionSchema, {
  name: 'resolve_pending_confirmation',
});

const ADDITION_PREFIX_REGEX = /^(?:对[，,。\s]*)?(?:还有|还喜欢|也喜欢|另外(?:还有)?|再加上|而且|同时)(.+)$/;
const BOTH_VALUES_REGEX = /^(?:两个|两种|这些)?(?:我)?(?:都|全)(?:是|要|喜欢|可以|对)[。！!～~]?$/;

function cleanSupplement(text) {
  return String(text || '')
    .replace(/^[，,。！？!?；;：:\s]+|[，,。！？!?；;：:～~\s]+$/g, '')
    .replace(/^(?:我)?(?:还|也)?(?:喜欢|爱吃|会吃|会做|想要)/, '')
    .replace(/的$/, '')
    .trim();
}

function detectSupplementalConfirmation(pending, userText) {
  const match = String(userText || '').trim().match(ADDITION_PREFIX_REGEX);
  if (!match) return null;
  const addition = cleanSupplement(match[1]);
  if (!addition || addition.length > 60) return null;

  const base = String(pending.newValue || '').replace(/，可能偏好/, '，偏好');
  let value;
  let acknowledgement;

  switch (pending.field) {
    case 'taste': {
      const normalizedAddition = /甜/.test(addition) ? '甜味' : addition;
      if (pending.reason?.type === 'dish_flavor_inference') {
        const inferredTasteLabel = pending.reason.inferredTaste.replace(/^偏/, '') +
          (pending.reason.inferredTaste.endsWith('味') ? '' : '味');
        value = `喜欢${pending.reason.dishName}，偏好${inferredTasteLabel}和${normalizedAddition}`;
        acknowledgement = `记下啦，你喜欢${pending.reason.dishName}这类${pending.reason.inferredTaste}口味，也喜欢${normalizedAddition}。`;
      } else {
        value = `${base}，也喜欢${normalizedAddition}`;
        acknowledgement = `记下啦，你的口味偏好还包括${normalizedAddition}。`;
      }
      break;
    }
    case 'restrictions':
      value = `${base}，还需避开${addition}`;
      acknowledgement = `记下啦，${addition}也需要避开。`;
      break;
    case 'goal':
      value = `${base}，也希望${addition}`;
      acknowledgement = `记下啦，${addition}也是你在意的目标。`;
      break;
    case 'exercise':
      value = `${base}，另外${addition}`;
      acknowledgement = `记下啦，你的运动情况还包括${addition}。`;
      break;
    case 'scene':
      value = `${base}，也会${addition}`;
      acknowledgement = `记下啦，除了刚才说的就餐场景，你也会${addition}。`;
      break;
    case 'budget':
      value = `${base}，另外${addition}`;
      acknowledgement = `记下啦，预算方面还要考虑${addition}。`;
      break;
    case 'cafeteriaMode':
      value = `${base}，也有${addition}`;
      acknowledgement = `记下啦，你们食堂也有${addition}这种方式。`;
      break;
    default:
      return null;
  }

  return { value, acknowledgement };
}

function mergeBothPendingValues(pending, userText) {
  if (!pending.oldValue || !BOTH_VALUES_REGEX.test(String(userText || '').trim())) return null;
  const oldValue = String(pending.oldValue);
  const newPart = cleanSupplement(pending.newValue);
  if (!newPart || oldValue.includes(newPart)) return null;

  if (pending.field === 'taste') {
    const addition = stripTasteValue(pending.newValue);
    return {
      value: `${oldValue}，也喜欢${addition}`,
      acknowledgement: `明白啦，不是改口，${oldValue.replace(/^喜欢/, '')}和${addition}你都喜欢。`,
    };
  }
  return {
    value: `${oldValue}，同时${newPart}`,
    acknowledgement: '明白啦，这两项我都帮你保留下来。',
  };
}

function stripTasteValue(value) {
  return String(value || '')
    .replace(/^(?:我)?(?:还|也)?(?:喜欢吃|喜欢|爱吃|偏好)/, '')
    .replace(/的$/, '')
    .trim();
}

async function resolvePendingConfirmation(state) {
  const pending = state.pendingConfirmation;
  const isFirstTimeSurprise = pending.oldValue === null;
  const lastUserMessage = findLastUserMessage(state.messages);
  const userText = getMessageText(lastUserMessage);
  const confirmationQueue = state.pendingConfirmationQueue || [];

  const supplemental = detectSupplementalConfirmation(pending, userText) || mergeBothPendingValues(pending, userText);
  if (supplemental) {
    const [nextPending, ...remaining] = confirmationQueue;
    return {
      messages: [{ role: 'ai', content: supplemental.acknowledgement }],
      slots: { [pending.field]: { value: supplemental.value, confirmed: true } },
      pendingConfirmation: nextPending || null,
      pendingConfirmationQueue: remaining,
      resumePreviousQuestion:
        !nextPending && Boolean(state.lastAskedSlot) && state.lastAskedSlot !== pending.field,
      skipCandidateFieldsOnce: [pending.field],
    };
  }

  function advanceConfirmation(extra = {}) {
    const [nextPending, ...remaining] = confirmationQueue;
    return {
      ...extra,
      pendingConfirmation: nextPending || null,
      pendingConfirmationQueue: remaining,
      resumePreviousQuestion:
        !nextPending && Boolean(state.lastAskedSlot) && state.lastAskedSlot !== pending.field,
    };
  }

  const prompt = [
    {
      role: 'system',
      content:
        (isFirstTimeSurprise
          ? '之前问了用户一个确认问题，大意是：从你刚才的话里，好像顺带' +
            `提取到了"${pending.newValue}"这个信息，这样理解对吗？`
          : `之前问了用户一个确认问题，大意是："你之前说的是${pending.oldValue}，` +
            `现在是想改成${pending.newValue}吗？"`) +
        '请判断用户这一轮的回复是同意' +
        '（confirmed）、否认（rejected），还是没有明确回应（unclear）。',
    },
    { role: 'human', content: userText },
  ];

  const { resolution } = await structuredResolver.invoke(prompt);

  if (resolution === 'confirmed') {
    return advanceConfirmation({
      slots: { [pending.field]: { value: pending.newValue, confirmed: true } },
    });
  }

  // 意外字段的首次候选值被否认/放弃时，不能落地成 {value: oldValue,
  // confirmed: true}——oldValue 本来就是 null，那样会把这一项错误地
  // 标记成"已确认但没有值"，之后再也不会被追问。应该完全恢复成
  // 从没发生过一样：{value: null, confirmed: false}，等着被正常问到
  // 或者用户之后再主动提起。
  const revertSlot = () =>
    isFirstTimeSurprise
      ? { value: null, confirmed: false }
      : { value: pending.oldValue, confirmed: true };

  if (resolution === 'rejected') {
    return advanceConfirmation({
      slots: { [pending.field]: revertSlot() },
    });
  }

  // unclear：如果已经问过太多次还是没能得到明确回应，不再追问，按
  // "放弃这次确认"处理，避免无限期卡住整个流程；否则保留
  // pendingConfirmation（同时把 askedCount 带上），交给下游再问一次。
  if ((pending.askedCount || 0) >= MAX_ASK_COUNT) {
    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[resolvePendingConfirmation] ${pending.field} 已经问了${pending.askedCount}次还是不清楚，放弃这次确认，恢复原状`);
    }
    return advanceConfirmation({
      slots: { [pending.field]: revertSlot() },
    });
  }

  return {};
}

module.exports = {
  resolvePendingConfirmation,
  detectSupplementalConfirmation,
  mergeBothPendingValues,
};

// 确认问题生成节点：conflictRouter 判定需要确认之后（真冲突/改口，或者
// 意外字段的首次候选值），这一步负责把 pendingConfirmation 里的信息，
// 转成一句自然口语化的确认问题发给用户，不直接落地——等用户回应之后，
// 由 resolvePendingConfirmation 节点根据用户的回答决定是否真的更新状态。
//
// pending.oldValue 为 null 时，表示这不是"改口"，而是 AI 本轮没有问、
// 但 candidateSlots 里意外冒出来的候选值（第一次出现，没有旧值可比较），
// 这种情况的确认问法跟"改口确认"不一样，要分开处理。
//
// askedCount：记录这个待确认事项已经问过几次。真实测试发现，如果用户
// 一直不正面回应这个确认问题、只是继续往下正常回答别的问题，
// routeAfterConflictCheck 会一直把每一轮都送回这里，原地重复问同一句
// 问题，还会连带卡住 lastAskedSlot 的推进，导致后续所有"意外字段"都
// 被反复丢弃、永远等不到解决——表现跟死锁几乎一样。这个计数是给
// resolvePendingConfirmation 用的：问过太多次还是没有明确回应，就
// 应该自动放弃这次确认，把主动权还给对话，不能无限期卡住整个流程。
const { model } = require('../model');
const { SLOT_LABELS } = require('../state');
const { findLastUserMessage, getMessageText } = require('../utils/messages');
const { FIRST_TURN_INTRO, getFixedProductAnswer, isFirstConversationTurn } = require('./askNextQuestion');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { detectWeightSafetyResponse } = require('../weightSafety');

const SIDE_QUESTION_REGEX = /[？?]|(吗|嘛|么|为什么|怎么|如何|什么意思|能不能|可不可以|有没有)[。！!～~]?$/;

async function askConfirmation(state) {
  const pending = state.pendingConfirmation;
  const isFirstTimeSurprise = pending.oldValue === null;
  const askedCount = (pending.askedCount || 0) + 1;
  const lastUserText = getMessageText(findLastUserMessage(state.messages));

  if (pending.field === 'goal') {
    const weightSafety = detectWeightSafetyResponse({
      userText: lastUserText,
      goalText: pending.newValue,
      bodyProfile: state.bodyProfile || {},
    });
    if (weightSafety) {
      const firstTurnIntro = isFirstConversationTurn(state.messages) ? FIRST_TURN_INTRO : null;
      return {
        messages: [firstTurnIntro, weightSafety.text]
          .filter(Boolean)
          .map((content) => ({ role: 'ai', content })),
        pendingConfirmation: null,
        ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
        ...(state.directQuestionAnsweredThisTurn ? { directQuestionAnsweredThisTurn: false } : {}),
      };
    }
  }

  let response;
  if (pending.reason?.type === 'dish_flavor_inference') {
    response = {
      content: `${pending.reason.dishName}通常会做得${pending.reason.inferredTaste}，我先理解成你喜欢带辣的口味，对吗？`,
    };
  } else if (pending.reason?.type === 'dish_collection_inference') {
    const existingFoods = pending.oldValue ? `之前记录的${pending.oldValue}` : '之前记录的食物';
    response = {
      content:
        `我会把${existingFoods}和新补充的${pending.reason.dishName}都保留在口味清单里，不会覆盖掉。` +
        `${pending.reason.dishName}通常偏${pending.reason.inferredTaste}，我先综合理解成你也喜欢${pending.reason.inferredTaste}口味，对吗？`,
    };
  } else if (pending.field === 'goal' && isFirstTimeSurprise) {
    response = { content: `我理解的是，你目前想要“${pending.newValue}”，对吗？` };
  } else {
    response = { content: buildConfirmationText(pending) };
  }
  const fixedAnswer = state.directQuestionAnsweredThisTurn ? null : getFixedProductAnswer(lastUserText);
  let sideAnswer = null;
  if (!state.directQuestionAnsweredThisTurn && !fixedAnswer && SIDE_QUESTION_REGEX.test(lastUserText.trim())) {
    const sideResponse = await model.invoke([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content:
          '用户没有直接回答当前待确认问题，而是在追问秘书上一句话。先只回答用户现在追问的内容，控制在一到两句话，' +
          '不要忽略问题，不要继续信息采集，不要使用破折号或连续横线；待确认问题会由下一条独立消息继续询问。',
      },
      ...state.messages,
    ]);
    sideAnswer = String(sideResponse.content || '').trim();
  }
  const firstTurnIntro = isFirstConversationTurn(state.messages) ? FIRST_TURN_INTRO : null;
  const openingMessage = [firstTurnIntro, fixedAnswer || sideAnswer].filter(Boolean).join('\n');
  const replyMessages = [openingMessage, response.content].filter(Boolean);
  if (state.emotionalSupportDeliveredThisTurn && replyMessages.length > 0) {
    const lastIndex = replyMessages.length - 1;
    replyMessages[lastIndex] = `如果你愿意，我们先从你刚提到的这件事聊起，好吗？${replyMessages[lastIndex]}`;
  }

  return {
    messages: replyMessages.map((content) => ({ role: 'ai', content })),
    pendingConfirmation: { ...pending, askedCount },
    ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
    ...(state.directQuestionAnsweredThisTurn ? { directQuestionAnsweredThisTurn: false } : {}),
  };
}

function buildConfirmationText(pending) {
  const label = SLOT_LABELS[pending.field] || '这项信息';
  if (pending.oldValue === null || pending.oldValue === undefined) {
    return `这里我理解成“${pending.newValue}”，对吗？`;
  }
  return `${label}前面记录的是“${pending.oldValue}”，现在需要改成“${pending.newValue}”，对吗？`;
}

module.exports = { askConfirmation, buildConfirmationText };

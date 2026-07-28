// 提问节点：checkCompleteness 已经决定好这一轮该问六项里的哪一项
// （state.nextSlotToAsk），这个节点只负责把这个具体问题自然地问出来。
//
// 完整复用 backend/src/services/systemPrompt.js 里现有的全部规则
// （格式铁律13-16、真实性铁律、第25条数字歧义澄清、第42条禁止编造
// 用户原话等），不重新写一套简化版提示词——这些规则是经过大量真实
// 测试验证过的，换成 LangGraph 架构不能把已经解决过的问题重新踩一遍。
//
// 额外只加一句任务说明，告诉模型"这一轮该问哪一项已经由外部状态决定
// 好了，不用自己判断六项采集进度、不用自己决定问题顺序"——避免模型
// 看到完整提示词里第1/4/20/24/32/40条这些"六项采集流程"相关规则后，
// 又自己重新判断一遍进度，跟状态机的决定打架。
//
// 真实测试发现：光靠 taskInstruction 里"严格禁止提前出方案"这句话，
// 在长对话历史下（10+轮，尤其是经历过几轮确认/待确认循环之后）还是
// 会失守——模型会在明明 checkCompleteness 判定"还没收集完"的情况下，
// 生成"六项信息确认完毕"之类的措辞，并且直接给出具体菜品+分量的完整
// 方案。这是"AI输出跟状态机真实判断矛盾"，跟"场景值前后矛盾""编造
// 用户原话"是同一类严重程度的问题，不能只靠继续加强提示词措辞——
// 这次改成代码层面的确定性检测：只要 askNextQuestion 被调用（也就是
// state.isComplete 在这一轮必然是 false），生成的回复文本如果命中
// "声称六项已确认完毕"或者"直接给出组合菜品方案"这类模式，一律判定
// 为矛盾，走跟 formatGuard 一样的重新生成流程，不依赖模型自觉。
const { model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { generateWithFormatGuard } = require('../../services/formatGuard');
const { SLOT_KEYS, SLOT_LABELS } = require('../state');
const { getMessageRole, getMessageText } = require('../utils/messages');

const PREMATURE_PLAN_PATTERNS = [
  {
    type: 'claims_complete',
    regex: /六项(信息)?[^。！？\n]{0,10}(确认完(毕)?|收集(齐|全)了?|集齐|对齐(啦|了)?|(就|都)齐(啦|了)?|都(了解|清楚|问完|齐全)(到|啦|了)?)/,
    detail: '声称"六项信息确认完毕/收集齐/对齐/齐啦"这类措辞',
  },
  {
    type: 'dish_combo_marker',
    regex: /[＋+]/,
    detail: '用"＋"把多道菜组合成一份方案（generatePlan才该做的事）',
  },
  {
    type: 'plan_feedback_prompt',
    regex: /(你觉得(这[个顿套餐份方案])?(怎么样|如何)?[？?]|想调整哪部分|要不要换一个|不爱吃\/?没有的话，?直接说换一个)/,
    detail: '像是在等用户对一份已经给出的具体方案做反馈',
  },
  {
    type: 'substitute_dish_phrase',
    regex: /(如果食堂没有|要是食堂(今天)?没有)[^。！？\n]*换成/,
    detail: '出现了第43条"食堂没有就换成XX"这类只有出方案时才该有的替代方案话术',
  },
];

function detectPrematurePlan(text) {
  return PREMATURE_PLAN_PATTERNS.filter((p) => p.regex.test(text)).map((p) => ({ type: p.type, detail: p.detail }));
}

function buildPrematurePlanRetryInstruction(violations, slotLabel) {
  const parts = violations.map((v, i) => `${i + 1}. ${v.detail}`).join('\n');
  return (
    '上一次生成的内容有严重问题，必须重新生成：外部状态机已经明确判定这一轮' +
    `信息还没收集完（还差"${slotLabel}"这一项），但上一次的回复却出现了以下` +
    `跟这个判断矛盾的内容：\n${parts}\n这一轮唯一的任务是自然地问出` +
    `"${slotLabel}"这一项，绝对不能声称六项已经收集完、不能给出任何具体的` +
    '菜品组合方案、不能用"你觉得这个方案怎么样"这类语气收尾——这些都是出方案' +
    '环节该做的事，这一轮完全不适用，请重新生成一版单纯的提问。'
  );
}

function formatKnownSlots(slots) {
  const known = SLOT_KEYS.filter((key) => slots[key] && slots[key].value).map((key) => {
    const slot = slots[key];
    return `${SLOT_LABELS[key]}: ${slot.value}${slot.confirmed ? '（已确认）' : '（未确认，待确认中）'}`;
  });
  return known.length > 0 ? known.join('\n') : '（目前还没有任何一项信息）';
}

async function askNextQuestion(state) {
  const nextSlot = state.nextSlotToAsk;
  const slotLabel = SLOT_LABELS[nextSlot];

  const taskInstruction =
    `【本轮任务】六项信息采集里，"${slotLabel}"这一项还没有确认，你这一轮需要` +
    `把这一项问出来。已经确认的信息：\n${formatKnownSlots(state.slots)}\n\n` +
    '六项信息该问哪一项、进度如何，已经由外部状态决定好了（已经明确告诉你要问' +
    `"${slotLabel}"），你不需要自己判断采集进度、不需要自己决定问题顺序，只需要` +
    '结合上面完整的系统规则（对话流程/情绪优先/格式/真实性等所有规则依然全部' +
    '生效），把这一项自然地问出来。\n\n' +
    '【严格禁止】这一轮唯一的任务就是问出这一项缺失的信息，绝对不能在这一轮' +
    '提前给出任何具体的饮食方案、菜品推荐、分量建议——哪怕你觉得已经确认的' +
    '信息看起来已经足够多、已经能大概判断出方案该怎么搭，也必须忍住不要提前' +
    '给。是否已经可以出方案，这个判断已经由外部状态机做出了明确结论（现在' +
    `的结论是"还不能出方案，还差${slotLabel}这一项"），不是由你自己根据` +
    '对话内容判断的，你不需要也不能重新评估这个结论。完整系统规则里如果有' +
    '类似"信息差不多齐了可以先给个初步方向"这类说法，这一轮不适用，以这条' +
    '禁止项为准——提前给方案是这一轮最严重的错误，比问题问得不够自然更严重。';

  const userMessages = state.messages
    .filter((m) => getMessageRole(m) === 'human')
    .map((m) => getMessageText(m));

  async function generateOnce(prematurePlanInstruction) {
    return generateWithFormatGuard({
      userMessages,
      generate: async (retryInstruction) => {
        const messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'system', content: taskInstruction },
          ...(prematurePlanInstruction ? [{ role: 'system', content: `【重新生成要求】${prematurePlanInstruction}` }] : []),
          ...(retryInstruction ? [{ role: 'system', content: `【重新生成要求】${retryInstruction}` }] : []),
          ...state.messages,
        ];
        const response = await model.invoke(messages);
        return response.content;
      },
    });
  }

  // "提前出方案"这类矛盾单独用一层重试包住 generateWithFormatGuard——
  // 这不是格式问题，是回复内容跟外部状态机的真实判断矛盾，检测逻辑
  // 需要知道 slotLabel/nextSlot 这些跟这个节点强相关的信息，不适合
  // 塞进跟具体链路解耦的 formatGuard 里，所以单独在这里做。
  let replyText = '';
  let prematurePlanViolations = [];
  const MAX_PREMATURE_PLAN_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_PREMATURE_PLAN_RETRIES; attempt += 1) {
    const extraInstruction =
      attempt === 0 ? null : buildPrematurePlanRetryInstruction(prematurePlanViolations, slotLabel);
    // eslint-disable-next-line no-await-in-loop
    const result = await generateOnce(extraInstruction);
    replyText = result.text;
    prematurePlanViolations = detectPrematurePlan(replyText);

    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `[askNextQuestion] 第${attempt + 1}次生成${
          prematurePlanViolations.length === 0
            ? '没有提前出方案矛盾'
            : `命中"提前出方案"矛盾: ${prematurePlanViolations.map((v) => v.type).join(', ')}`
        }`
      );
    }

    if (prematurePlanViolations.length === 0) break;
  }

  if (process.env.LANGGRAPH_DEBUG) {
    if (prematurePlanViolations.length > 0) {
      // eslint-disable-next-line no-console
      console.log('[askNextQuestion] 重试耗尽仍命中"提前出方案"矛盾，按最后一次生成结果返回:', replyText);
    }
    // eslint-disable-next-line no-console
    console.log(`[askNextQuestion] 问的是: ${nextSlot}`);
    // eslint-disable-next-line no-console
    console.log('[askNextQuestion] 生成的问题:', replyText);
  }

  return {
    messages: [{ role: 'ai', content: replyText }],
    lastAskedSlot: nextSlot,
  };
}

module.exports = { askNextQuestion };

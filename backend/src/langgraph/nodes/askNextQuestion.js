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
//
// 真实测试里陆续观察到三种不同的规避方式（甩完整菜单 -> 说"确认完毕" ->
// 把六项当既成事实列出来+问一句无关的"午餐还是晚餐"），第三种甚至没有
// 被下面这套文字模式命中，还连累到后面 generatePlan 那一轮直接continue
// 了这句无关提问、真的没给出方案。继续靠"再枚举一种新说法"来堵，大概率
// 还会有第四种——所以在 PREMATURE_PLAN_PATTERNS 这套已验证有效的快速
// 正则之外，加了 checkAsksTargetSlot 这道更根本的语义检测：不管模型这一
// 轮具体怎么措辞，只判断一件事——这段回复里有没有真的针对 nextSlotToAsk
// 这个具体缺失字段提问。只要没有实质提问到这一项，不管是甩方案、说
// 齐了、还是问了别的无关问题，都判定不合格，不用再一个个去追新的说法。
const { z } = require('zod');
const { model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { generateWithFormatGuard } = require('../../services/formatGuard');
const { SLOT_KEYS, SLOT_LABELS } = require('../state');
const { getMessageRole, getMessageText } = require('../utils/messages');

const targetSlotCheckSchema = z.object({
  asksAboutTargetSlot: z
    .boolean()
    .describe(
      '这段AI回复有没有实质性地向用户提问/确认"目标字段"的具体内容。不管用什么' +
        '措辞、语气、话术（哪怕夹在闲聊、共情、举例里），只要这段回复里真的包含' +
        '一句明确指向目标字段本身的问题，就是true。如果这段回复完全没有针对' +
        '目标字段提问——比如：直接给出了具体的饮食方案/菜品组合；声称六项信息' +
        '已经收集完整/都齐了；把目标字段的值当成既成事实直接写出来，却问的是' +
        '跟目标字段无关的其他问题（比如问预算多少、问打算午餐还是晚餐吃、问' +
        '要不要现在开始）；或者只是闲聊、没有把话题带回目标字段——都算false。'
    ),
});

const targetSlotCheckModel = model.withStructuredOutput(targetSlotCheckSchema, {
  name: 'check_asks_target_slot',
});

async function checkAsksTargetSlot(replyText, slotLabel) {
  const prompt = [
    {
      role: 'system',
      content:
        '你是一个质检助手，只做一件事：判断下面这段AI回复，有没有实质性地在向' +
        `用户提问/确认"${slotLabel}"这一项信息。这是唯一的判断标准，不用管回复` +
        `措辞自然不自然、语气好不好，只关心"这段话里到底有没有一句真正指向` +
        `"${slotLabel}"这个具体字段的问题"——哪怕回复顺带聊了别的、举了例子、` +
        '共情了几句，只要最终真的问到了这一项，就算true；哪怕回复读起来很像' +
        '在收尾确认信息，但实际问的是别的字段、或者压根没提问，就算false。',
    },
    { role: 'human', content: replyText },
  ];
  const result = await targetSlotCheckModel.invoke(prompt);
  return result.asksAboutTargetSlot;
}

const PREMATURE_PLAN_PATTERNS = [
  {
    // 之前只列举"确认完毕/收集齐/对齐"等具体措辞，真实测试发现模型会换成
    // "确认齐全""都齐了""全部齐了"这类没枚举到的说法就绕过去了——改成
    // "六项…（15字以内）…齐/全/完"这种更宽的邻近匹配，不再逐个词穷举。
    type: 'claims_complete',
    regex: /六项(信息)?[^。！？\n]{0,15}[齐全完]/,
    detail: '声称"六项信息确认完毕/收集齐/对齐/齐啦/齐全"这类措辞',
  },
  {
    type: 'dish_combo_marker',
    regex: /[＋+]/,
    detail: '用"＋"把多道菜组合成一份方案（generatePlan才该做的事）',
  },
  {
    // dish_combo_marker只认"＋"，真实测试发现模型换成"、"/"再加一份"连接
    // 多道菜就绕过去了——这条不看连接符，直接认"现在/接下来...给你搭...
    // 具体吃法"这类"马上就要给方案了"的模板句式，更难绕开。第一版只认
    // "具体吃法"本身，结果把"我是专门帮你搭配...具体吃法"这种自我介绍
    // 也当误命中了——加上"现在/接下来/那咱们就"这类紧邻的即时性状语，
    // 只抓"这就要给你上方案了"的说法，不抓泛泛的能力介绍。
    type: 'concrete_plan_phrase',
    regex: /(现在|接下来|那咱们(就)?|马上|这就)[^。！？\n]{0,8}给你搭(配)?[^。！？\n]{0,8}(具体|一[份餐版顿套]|个)/,
    detail: '出现了"现在/接下来就给你搭一份具体吃法"这类只有出方案环节才该说的模板句式',
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

// 正则命中的几类是已经验证过的快速通道，不用等一次模型调用就能拦下来；
// 但真实测试证明模型总能找到没被枚举到的新说法绕过去，所以这里加上
// checkAsksTargetSlot 兜底——不管正则有没有命中，都再问一遍"这段话到底
// 有没有实质问到目标字段"，这条判断跟具体措辞无关，理论上能覆盖所有
// 未来可能出现的新规避方式，不用再靠不断新增正则去追。
async function detectAskNextQuestionViolations(text, slotLabel) {
  const violations = detectPrematurePlan(text);
  const asksTarget = await checkAsksTargetSlot(text, slotLabel);
  if (!asksTarget) {
    violations.push({
      type: 'not_asking_target_slot',
      detail: `这段回复没有实质性地问到"${slotLabel}"这一项（不管具体怎么措辞，只要没有真的把话题带回这个字段就算）`,
    });
  }
  return violations;
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
    // eslint-disable-next-line no-await-in-loop
    prematurePlanViolations = await detectAskNextQuestionViolations(replyText, slotLabel);

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

  // 真实测试发现一个比"检测到矛盾"更严重的连锁问题：如果3次重试都没能
  // 摆脱矛盾，之前的做法是"按最后一次生成结果返回"——这次生成本身还是
  // 违规的（声称六项已齐、还带着具体菜品方案），一旦它被存进对话历史，
  // 下一轮模型会看到"自己刚才已经给过方案"这个既成事实，觉得应该顺着
  // 说下去而不是收回，于是矛盾会在后续每一轮持续复现、越纠正越纠正不
  // 回来。所以重试耗尽后不能再把这次违规生成放进历史——改成完全跳过
  // 模型，用一句确定性的模板问题兜底，保证绝不会有"声称已完成/具体
  // 方案"这类内容混进对话历史，牺牲一次的自然度换取不把矛盾传染给
  // 后面所有轮次。
  if (prematurePlanViolations.length > 0) {
    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        '[askNextQuestion] 重试耗尽仍命中"提前出方案"矛盾，放弃这次生成结果（不能让它混进对话历史），改用确定性兜底问题:',
        replyText
      );
    }
    replyText = `不好意思，刚才有点跑偏了——"${slotLabel}"这一项我还没跟你确认清楚，方便直接告诉我一下吗？`;
  }

  if (process.env.LANGGRAPH_DEBUG) {
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

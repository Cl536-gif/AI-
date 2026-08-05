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
const { model, classifierModel } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { generateWithFormatGuard } = require('../../services/formatGuard');
const { buildServiceBoundaryAnswer, buildReminderCapabilityAnswer } = require('../../pricingConfig');
const { SLOT_KEYS, SLOT_LABELS, TRACKED_SLOT_KEYS } = require('../state');
const { getUndeliveredMuscleGoalGuidance } = require('../goalGuidance');

const CAFETERIA_MODE_QUESTION =
  '不同食堂的打饭方式不太一样，我再了解一下你们食堂的情况～如果能自己挑菜，我会直接帮你搭配主食、菜和分量；' +
  '如果是窗口已经配好的套餐，我会告诉你拿到套餐后怎么取舍和替换。你们食堂更接近哪一种呀？';

const PRODUCT_INFO_QUESTION_REGEX = /(付费|收费|免费|花钱|多少钱|价格|价钱)/;
const REMINDER_QUESTION_REGEX = /(提醒|推送|定时|通知).*(吗|嘛|么|能不能|可以)|能不能.*(提醒|推送)|可以.*(提醒|推送)/;
const SERVICE_OPTION_QUESTION_REGEX = /(有哪些|什么).*(选择|选项|模式|功能)|怎么选|两种方式|服务区别/;
const CAPABILITY_QUESTION_REGEX = /(你能帮我什么|能帮我什么|你可以帮我什么|你能帮到我什么|能帮到我什么|你会做什么|你有什么用|能做什么)/;
const MALE_SELF_DISCLOSURE_REGEX = /(?:(?:我是|本人是|我算是|性别(?:是|为)?)[^。！？]{0,8}(?:男大学生|男学生|男生|男性|男的)|(?:^|[，,。！？!?；;：:\s])(?:在校)?男大学生(?:[，,。！？!?；;：:\s]|$))/;
const WEARABLE_CALORIE_QUESTION_REGEX = /(手表[^。！？]*(等量|补回|什么意思|为什么)|不[^。！？]*按[^。！？]*手表[^。！？]*(等量|补回)|等量补回[^。！？]*(什么意思|为什么))/;
const GENERAL_QUESTION_REGEX = /[？?]|(吗|嘛|么|为什么|怎么|如何|能不能|可不可以|有没有)[。！!～~]?$/;
const GOAL_QUESTION_REGEX = /(整体感受|整体状态|整体达到|身材目标|想达到|想改善|希望达到|最想改善|达到什么样)[^。！？\n]*[？?]/;

const FIRST_TURN_INTRO =
  '你好～我是你的私人健康饮食管理秘书，会先了解你的真实饮食习惯，再陪你一点点找到更适合自己的吃法。';
const RESUME_PREVIOUS_QUESTION_MESSAGE = '那先来回答一下前面问你的问题～';
const EMOTIONAL_START_SCENE_QUESTION =
  '如果你愿意，我们就从最基础、最容易回答的一点开始聊聊，不用一下子说很多，好吗？你平时吃饭主要是食堂还是外卖呀？';
const FOOD_REJECTION_REGEX = /(不爱吃|不喜欢吃|不想吃|吃不惯|换一个|换掉)/;
const TASTE_PROFILE_SCENE_TRANSITION =
  '如果想让我给出的搭配更符合你的口味，还需要先聊聊你平时的饮食习惯～' +
  '我们先从最基础的开始：你平时吃饭主要是食堂还是外卖呀？';

function normalizeFoodRejectionTransition(text, userText, nextSlot) {
  if (nextSlot !== 'scene' || !FOOD_REJECTION_REGEX.test(String(userText || ''))) return text;
  const value = String(text || '').trim();
  const replaced = value.replace(
    /(?:顺便(?:再)?确认一下|那(?:再|先)?确认一下)[：:，,]?\s*[\s\S]*$/,
    TASTE_PROFILE_SCENE_TRANSITION
  );
  if (replaced !== value) return replaced;
  return value.replace(
    /[^。！？\n]*(?:食堂)[^。！？\n]*(?:外卖)[^。！？\n]*[？?][～~]?$/,
    TASTE_PROFILE_SCENE_TRANSITION
  );
}

const CAPABILITY_ANSWER =
  '我主要帮你把“这一顿具体怎么吃”说清楚：结合你的日常场景、口味和预算，直接告诉你主食、菜和分量怎么搭，没有合适的也会准备替换办法。' +
  '食堂能自己选菜时，我会帮你组合；拿到的是固定套餐，我会告诉你怎么取舍；点外卖时，我会根据实际能买到的餐食帮你调整。' +
  '我们不用一下子把原来的习惯全改掉，先从最容易做到的一顿开始。我会陪你一步一步调整，让饮食越来越稳定，也慢慢朝你想要的健康状态和身材目标靠近～';

const MALE_SERVICE_BOUNDARY_ANSWER =
  '明白～目前长期饮食定制和阶段调整主要面向想减脂、塑形的在校女生。' +
  '不过你仍然可以问我增肌、日常搭配、食堂选菜或外卖选择等饮食问题，我也会结合你的情况给出第一版基础建议；' +
  '只是暂时不会进入长期跟踪调整。';

const WEARABLE_CALORIE_ANSWER =
  '意思是手表显示的消耗只是估算值，比如显示消耗300千卡，并不代表就要额外吃回300千卡。' +
  '我会把这个数字和运动类型、时长、强度及当天饮食一起作为参考，再判断是否需要调整正餐或加餐。';

function getFixedProductAnswer(userText) {
  if (WEARABLE_CALORIE_QUESTION_REGEX.test(userText)) return WEARABLE_CALORIE_ANSWER;
  if (MALE_SELF_DISCLOSURE_REGEX.test(userText)) return MALE_SERVICE_BOUNDARY_ANSWER;
  if (CAPABILITY_QUESTION_REGEX.test(userText)) return CAPABILITY_ANSWER;
  if (REMINDER_QUESTION_REGEX.test(userText)) return buildReminderCapabilityAnswer();
  if (PRODUCT_INFO_QUESTION_REGEX.test(userText) || SERVICE_OPTION_QUESTION_REGEX.test(userText)) {
    return buildServiceBoundaryAnswer();
  }
  return null;
}

function isFirstConversationTurn(messages) {
  const humanCount = messages.filter((m) => getMessageRole(m) === 'human').length;
  const aiCount = messages.filter((m) => getMessageRole(m) === 'ai').length;
  return humanCount === 1 && aiCount === 0;
}

function composeReplyMessages({ replyText, sideAnswer, fixedProductAnswer, isFirstTurn }) {
  let generatedText = replyText.trim();
  if (isFirstTurn) {
    // 自我介绍由固定模板负责；如果模型仍自行加了“你好/嗨”，只剥掉问候词，
    // 保留后面可能存在的有效回答和采集问题。
    generatedText = generatedText.replace(/^(你好|嗨)[呀啊哈～~，,\s]*/, '');
  }
  const answerText = fixedProductAnswer || sideAnswer;
  const firstMessage = [isFirstTurn ? FIRST_TURN_INTRO : null, answerText].filter(Boolean).join('\n');
  return [firstMessage, generatedText].filter(Boolean);
}
const { getMessageRole, getMessageText } = require('../utils/messages');

// 第一版描述里用了"提问/确认"这个措辞，真实测试发现模型会把"记下啦：
// ……目前不运动"这种把值当成既成事实直接陈述出来的句子，也当成"确认"
// 命中了这一项，从而误判成true——哪怕这句话后面问的其实是完全无关的
// "午餐还是晚餐"。这是这道语义检测本身的盲点，不是又一种需要单独枚举
// 的规避说法，所以直接收紧判断标准本身：只认"有没有一句真正需要用户
// 回答、且问的就是这个字段"的疑问句，陈述句（哪怕内容是对的）一律不算。
const targetSlotCheckSchema = z.object({
  asksAboutTargetSlot: z
    .boolean()
    .describe(
      '这段AI回复的结尾或主体部分，有没有包含一句真正需要用户回答的疑问句，' +
        '而且这句疑问句问的具体内容就是"目标字段"本身——是在向用户征询这一项' +
        '还没拿到的信息，不是在陈述/复述这一项已经知道（或者AI自己认为已经' +
        '知道）的值。\n' +
        '几种容易混淆、但必须判定为false的情况：\n' +
        '1. 回复把目标字段的值当成已经确定的事实直接写出来（哪怕用了"记下啦"' +
        '这种像是在确认的语气词），然后并没有真的再向用户提问这一项，而是问了' +
        '别的事情、或者直接给了具体方案——这种情况即使字面提到了这个字段，也' +
        '算false，因为它没有在问，只是在陈述。\n' +
        '2. 回复只是闲聊，没把话题带回这个字段。\n' +
        '3. 回复直接给出了具体饮食方案，或者声称六项信息都收集完整。\n' +
        '判断依据是"这段话里有没有一句疑问句在向用户询问这件事"，不是"文本里' +
        '有没有出现这个字段相关的字眼"——出现了字眼但没有真的在问，仍然是' +
        'false。'
    ),
});

// 这是分类型判断（回复里有没有一句问到目标字段的疑问句），跟下面
// generateOnce 里生成自然回复用的 model（temperature:0.7）分开，用
// classifierModel（temperature:0）——真实测试发现最简单的首轮"你好"
// 开场白（明显合格，结尾就是一句合规的疑问句）偶尔也会被判成false，
// 这类偶发误判正是高temperature给分类任务引入的噪音，不是判断逻辑
// 本身有漏洞。
const targetSlotCheckModel = classifierModel.withStructuredOutput(targetSlotCheckSchema, {
  name: 'check_asks_target_slot',
});

async function checkAsksTargetSlot(replyText, slotLabel, slotKey) {
  // “身材目标”允许用户用“整体感受/状态”作答。真实测试中分类模型连续
  // 把这类明确问句判成false，先用确定性语义短语做快速通道。
  if (slotKey === 'goal' && GOAL_QUESTION_REGEX.test(replyText)) return true;
  const prompt = [
    {
      role: 'system',
      content:
        '你是一个质检助手，只做一件事：判断下面这段AI回复的结尾或主体部分，' +
        `有没有包含一句真正需要用户回答、且问的就是"${slotLabel}"这一项本身的` +
        '疑问句。这是唯一的判断标准，不用管回复措辞自然不自然、语气好不好。\n' +
        `注意：如果回复只是把"${slotLabel}"的值当成已经知道的事实陈述出来` +
        '（哪怕用了"记下啦""明白了"这类听起来像在确认的语气词），然后话题' +
        `转向了别的方向（问别的字段、给方案、问无关的事），这不算问到了` +
        `"${slotLabel}"——必须是真的有一句疑问句在向用户征询这一项还没拿到` +
        '的信息，才算true。哪怕回复顺带聊了别的、举了例子、共情了几句，只要' +
        '最终确实有这样一句疑问句，就算true；只是陈述、或者压根没提问，就算' +
        'false。',
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

const MAX_COLLECTION_QUESTION_LENGTH = 150;

function detectCollectionVerbosity(text) {
  if (text.trim().length <= MAX_COLLECTION_QUESTION_LENGTH) return [];
  return [{
    type: 'collection_question_too_verbose',
    detail:
      `这段采集回复有${text.trim().length}字，超过${MAX_COLLECTION_QUESTION_LENGTH}字；` +
      '用户没有要求解释时，只能简短承接一句、给少量必要示例，然后问一个问题',
  }];
}

function detectPrematurePlan(text) {
  return PREMATURE_PLAN_PATTERNS.filter((p) => p.regex.test(text)).map((p) => ({ type: p.type, detail: p.detail }));
}

// 正则命中的几类是已经验证过的快速通道，不用等一次模型调用就能拦下来；
// 但真实测试证明模型总能找到没被枚举到的新说法绕过去，所以这里加上
// checkAsksTargetSlot 兜底——不管正则有没有命中，都再问一遍"这段话到底
// 有没有实质问到目标字段"，这条判断跟具体措辞无关，理论上能覆盖所有
// 未来可能出现的新规避方式，不用再靠不断新增正则去追。
async function detectAskNextQuestionViolations(text, slotLabel, slotKey) {
  const violations = [...detectPrematurePlan(text), ...detectCollectionVerbosity(text)];
  const asksTarget = await checkAsksTargetSlot(text, slotLabel, slotKey);
  if (!asksTarget) {
    violations.push({
      type: 'not_asking_target_slot',
      detail: `这段回复没有实质性地问到"${slotLabel}"这一项（不管具体怎么措辞，只要没有真的把话题带回这个字段就算）`,
    });
  }
  return violations;
}

// 诊断"首轮开场白偶尔漏问必答问题"这个具体案例时，用完整文本调试
// 日志跑了12轮，发现不是随机噪音：命中 not_asking_target_slot 的
// 文本，字符对字符全是同一句——systemPrompt.js第36条"中性开场铁律"
// 里给的示例原句"你好呀～最近有在关注饮食或身材管理方面的事吗？"。
// 模型把这句示例原样抄下来当成完整回复就停住了，没意识到这只是
// 示例的前半句，后面必须紧接着问出目标字段。3次触发兜底模板的
// 轮次，3次重试生成的都是这句一模一样的短句——说明泛泛的"请重新
// 生成"这个通用指令，对这种"抄示例抄上瘾"的情况没什么纠正力度，
// 需要专门点破"这是抄了示例、没接上必答问题"，比通用retry指令更
// 精准。第36条示例文字本身也已经改成带上后续过渡句+场景问题的
// 完整段落（见 systemPrompt.js），这里是配套的第二层兜底——万一
// 提示词层面没完全根治，重试阶段还能针对性纠正一次。
const KNOWN_HALF_OPENER_REGEX = /^你好呀[～~][^。！？\n]*关注饮食或身材管理方面的事(吗|呢)[？?]$/;

function isKnownHalfOpener(text) {
  return KNOWN_HALF_OPENER_REGEX.test(text.trim());
}

function buildPrematurePlanRetryInstruction(violations, slotLabel, previousReplyText) {
  if (previousReplyText && isKnownHalfOpener(previousReplyText)) {
    return (
      `上一次生成的内容"${previousReplyText}"，只是systemPrompt里第36条"中性开场"` +
      '举例用的前半句，你把这句示例原样当成了一句完整回复、说完就停住了——这句话' +
      '本身只是"怎么中性接话、不替用户编造诉求"这一个点的示范，不是一句独立、说完' +
      `就算完整回复的话。这一轮必须在这句话后面紧接着往下说完过渡句，再问出` +
      `"${slotLabel}"这一项，不能只停在开场问候这一句就结束，重新生成一版包含完整` +
      '过渡+提问的段落。'
    );
  }

  const parts = violations.map((v, i) => `${i + 1}. ${v.detail}`).join('\n');
  return (
    '上一次生成的内容有严重问题，必须重新生成：外部状态机已经明确判定这一轮' +
    `信息还没收集完（还差"${slotLabel}"这一项），但上一次的回复却出现了以下` +
    `跟这个判断矛盾的内容：\n${parts}\n这一轮唯一的任务是自然地问出` +
    `"${slotLabel}"这一项，绝对不能声称六项已经收集完、不能给出任何具体的` +
    '菜品组合方案、不能用"你觉得这个方案怎么样"这类语气收尾；同时不要重复介绍能力、' +
    '不要换句话复述同一层意思、举例最多保留三个，简短承接后只问一个问题——这些都是出方案' +
    '环节该做的事，这一轮完全不适用，请重新生成一版单纯的提问。'
  );
}

function formatKnownSlots(slots) {
  const known = TRACKED_SLOT_KEYS.filter((key) => slots[key] && slots[key].value).map((key) => {
    const slot = slots[key];
    return `${SLOT_LABELS[key]}: ${slot.value}${slot.confirmed ? '（已确认）' : '（未确认，待确认中）'}`;
  });
  return known.length > 0 ? known.join('\n') : '（目前还没有任何一项信息）';
}

async function askNextQuestion(state) {
  const nextSlot = state.nextSlotToAsk;
  const slotLabel = SLOT_LABELS[nextSlot];

  if (nextSlot === 'cafeteriaMode') {
    const resumeMessage = state.resumePreviousQuestion ? RESUME_PREVIOUS_QUESTION_MESSAGE : null;
    return {
      messages: [
        resumeMessage,
        state.emotionalSupportDeliveredThisTurn
          ? `如果你愿意，我们就从眼前最容易回答的一点继续聊聊，好吗？${CAFETERIA_MODE_QUESTION}`
          : CAFETERIA_MODE_QUESTION,
      ]
        .filter(Boolean)
        .map((content) => ({ role: 'ai', content })),
      lastAskedSlot: nextSlot,
      ...(resumeMessage ? { resumePreviousQuestion: false } : {}),
      ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
    };
  }

  const lastUserMessage = [...state.messages].reverse().find((m) => getMessageRole(m) === 'human');
  const lastUserText = lastUserMessage ? getMessageText(lastUserMessage) : '';
  const fixedProductAnswer = getFixedProductAnswer(lastUserText);
  const isFirstTurn = isFirstConversationTurn(state.messages);
  const hasGeneralQuestion = GENERAL_QUESTION_REGEX.test(lastUserText.trim());

  const taskInstruction =
    `【本轮任务】六项信息采集里，"${slotLabel}"这一项还没有确认，你这一轮需要` +
    `把这一项问出来。已经确认的信息：\n${formatKnownSlots(state.slots)}\n\n` +
    '六项信息该问哪一项、进度如何，已经由外部状态决定好了（已经明确告诉你要问' +
    `"${slotLabel}"），你不需要自己判断采集进度、不需要自己决定问题顺序，只需要` +
    '结合上面完整的系统规则（对话流程/情绪优先/格式/真实性等所有规则依然全部' +
    '生效），把这一项自然地问出来。\n\n' +
    (isFirstTurn
      ? '这是新对话的第一轮，外部代码会在回复最前面加上固定的身份介绍。你不要自行说“你好”“嗨”或重复自我介绍。\n\n'
      : '') +
    (state.resumePreviousQuestion
      ? '刚才为了核实用户同一句话里的另一项信息，临时插入了一个确认问题，现在要回到此前尚未回答的问题。' +
        '外部代码会先单独发送一句自然过渡；你这里只直接问目标字段，不要再说“继续问你”“再问一个”“回到正题”或重复解释流程。\n\n'
      : '') +
    (state.emotionalSupportDeliveredThisTurn
      ? '上一条消息已经完成了情绪共情、鼓励和解决方向。这里绝对不要再次说“压力很大”“焦虑”“抱抱”或重复安慰，' +
        '只需要自然承接并问目标字段；外部代码会加上是否愿意开始的过渡。\n\n'
      : '') +
    (fixedProductAnswer
      ? '用户这一轮还顺带问了产品功能、提醒、收费或服务选项问题，这部分会由外部代码用固定产品话术回答。' +
        '你生成的内容里不要重复回答产品问题，只继续完成本轮缺失信息的提问。\n\n'
      : hasGeneralQuestion
        ? '用户这一轮还提出了一个其他问题，这部分会由外部流程先单独回答。你不要重复回答，' +
          '这里只继续完成本轮缺失信息的提问。\n\n'
        : '') +
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

  let sideAnswer = null;
  if (hasGeneralQuestion && !fixedProductAnswer) {
    const sideResponse = await model.invoke([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content:
          '用户刚才先问了一个问题。只直接回答这个问题，控制在一到两句话；不要询问六项信息，' +
          '不要开始饮食信息采集，不要提前生成饮食方案。后续采集问题会由另一个步骤单独发送。',
      },
      ...state.messages,
    ]);
    sideAnswer = String(sideResponse.content || '').trim();
  }

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
      attempt === 0 ? null : buildPrematurePlanRetryInstruction(prematurePlanViolations, slotLabel, replyText);
    // eslint-disable-next-line no-await-in-loop
    const result = await generateOnce(extraInstruction);
    replyText = result.text;
    // eslint-disable-next-line no-await-in-loop
    prematurePlanViolations = await detectAskNextQuestionViolations(replyText, slotLabel, nextSlot);

    if (process.env.LANGGRAPH_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `[askNextQuestion] 第${attempt + 1}次生成${
          prematurePlanViolations.length === 0
            ? '没有提前出方案矛盾'
            : `命中"提前出方案"矛盾: ${prematurePlanViolations.map((v) => v.type).join(', ')}`
        }`
      );
      // 之前这里只打印了违规类型，没打印当次生成的完整文本——诊断"生成
      // 阶段偶尔漏问必答问题"这类问题时，只有最后一次（重试耗尽或者
      // 成功那次）的文本会在别处被打印出来，中间几次实际生成了什么完全
      // 看不到，没法判断失败样本有没有共同结构。每次都打印完整文本，
      // 不管这次成功还是命中违规。
      // eslint-disable-next-line no-console
      console.log(`[askNextQuestion] 第${attempt + 1}次生成的完整文本:`, replyText);
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
    replyText = `回到咱们刚才的话题，"${slotLabel}"这一项我还没跟你确认清楚，方便直接告诉我一下吗？`;
  }

  replyText = normalizeFoodRejectionTransition(replyText, lastUserText, nextSlot);

  if (state.emotionalSupportDeliveredThisTurn && nextSlot === 'scene') {
    replyText = EMOTIONAL_START_SCENE_QUESTION;
  } else if (state.emotionalSupportDeliveredThisTurn) {
    replyText = `如果你愿意，我们就从眼前最容易回答的一点继续聊聊，好吗？${replyText}`;
  }

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[askNextQuestion] 问的是: ${nextSlot}`);
    // eslint-disable-next-line no-console
    console.log('[askNextQuestion] 生成的问题:', replyText);
  }

  const replyMessages = composeReplyMessages({
    replyText,
    sideAnswer,
    fixedProductAnswer,
    isFirstTurn,
  });
  const muscleGoalGuidance = getUndeliveredMuscleGoalGuidance(state);
  const resumeMessage = state.resumePreviousQuestion ? RESUME_PREVIOUS_QUESTION_MESSAGE : null;

  return {
    messages: [muscleGoalGuidance, resumeMessage, ...replyMessages]
      .filter(Boolean)
      .map((content) => ({ role: 'ai', content })),
    lastAskedSlot: nextSlot,
    ...(muscleGoalGuidance ? { muscleGoalGuidanceDelivered: true } : {}),
    ...(resumeMessage ? { resumePreviousQuestion: false } : {}),
    ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
  };
}

module.exports = {
  askNextQuestion,
  CAFETERIA_MODE_QUESTION,
  checkAsksTargetSlot,
  detectAskNextQuestionViolations,
  FIRST_TURN_INTRO,
  RESUME_PREVIOUS_QUESTION_MESSAGE,
  EMOTIONAL_START_SCENE_QUESTION,
  CAPABILITY_ANSWER,
  MALE_SERVICE_BOUNDARY_ANSWER,
  MALE_SELF_DISCLOSURE_REGEX,
  WEARABLE_CALORIE_ANSWER,
  MAX_COLLECTION_QUESTION_LENGTH,
  detectCollectionVerbosity,
  getFixedProductAnswer,
  isFirstConversationTurn,
  composeReplyMessages,
  normalizeFoodRejectionTransition,
  TASTE_PROFILE_SCENE_TRANSITION,
};

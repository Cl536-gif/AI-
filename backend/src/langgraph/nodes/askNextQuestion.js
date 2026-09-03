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
// fix4c-2：收费质疑（"免费你凭什么收钱""为什么收费"）与纯问价分流——
// 质疑走模型第51条三段式对比话术，纯问价才走固定价格回答
const PRICE_CHALLENGE_REGEX =
  /(凭什么|为什么(?:收|要收|还要收)|(?:免费|不要钱|不花钱)[^。！？\n]{0,10}(?:凭什么|为什么|还|却|竟)|收(?:什么|我们的|这个)钱)/;
// fix4c-2：反驳/追问识别（"豆包也有记忆啊""但是…"）——宽正则+安全行为
// （先回应再采集，回应本身是好行为，误伤代价低），不得被采集漏斗吞掉
const COUNTER_ARGUMENT_REGEX = /(也有|还是有|但是|可是|那又|不过|就算|照样|难道|还不是)/;
// 点名即拦截：名单命中 100% 确定性走三段式（名单可后续追加，但不是防漏的主力）
const NAMED_AI_REGEX = /(豆包|DeepSeek|ChatGPT|GPT|文心|Kimi|通义|Gemini|Claude|讯飞|星火|智谱|GLM|Copilot|Siri|小爱)/;
// 对比主语：任何 AI 类实体或指代。认“实体感”不认“具体名字”
const AI_ENTITY_REGEX = /(AI|助手|机器人|大模型|软件|App|应用|工具|程序|它|它们|别人|人家|其他|别的|另外|那款|那个)/;
// 弹药一：免费（价格类表述，与 PRICE_CHALLENGE_REGEX 职责相邻，兜住价格正则未覆盖的免费攻击）
const COMPARISON_FREE_REGEX = /(免费|不要钱|不收钱|白嫖|凭什么(?:收钱|收费|要钱)|为啥(?:收钱|收费|要钱)|值得(?:买|付费|花这个钱))/;
// 弹药二：记忆（必须与对比主语共现，防止“我不记得昨天吃了什么”被误伤）
const MEMORY_ATTACK_REGEX = new RegExp(
  AI_ENTITY_REGEX.source + '[^。！？\\n]{0,15}(?:也有记忆|有记忆|能记住|记得住|记住了|记着|能回忆|有记忆功能)' +
  '|(?:也有记忆|能记住|记得住|有记忆功能)[^。！？\\n]{0,10}(?:AI|助手|机器人|大模型|软件|App|它|它们)'
);
// 弹药三：能力（同样必须与对比主语共现）
const ABILITY_ATTACK_REGEX = new RegExp(
  AI_ENTITY_REGEX.source + '[^。！？\\n]{0,15}(?:也能|同样能|更聪明|更强|更好|比(?:你|它)强|都能|一样能|还会|替代|取代|淘汰|没用了|用不上)' +
  '|(?:也能|同样能|更聪明|更强|更好)[^。！？\\n]{0,10}(?:AI|助手|机器人|大模型|软件|App|它|它们)'
);
const COMPARISON_CHALLENGE_REGEX = new RegExp(
  COMPARISON_FREE_REGEX.source + '|' + MEMORY_ATTACK_REGEX.source + '|' + ABILITY_ATTACK_REGEX.source
);
const MEMORY_COUNTER_REGEX = MEMORY_ATTACK_REGEX;
// 宽松版：与确定性正则“严+宽”互补，专捞未知名字的边角对比表达
const UNKNOWN_AI_COMPARISON_REGEX =
  /(AI|助手|机器人|大模型|软件|App|应用|工具|它|它们|别人|人家|别的|那个)[^。！？\n]{0,25}(也能|同样能|能做到|免费|有记忆|能记住|记得|比(?:你|它)强|替代|凭什么)/;
// fix4c：带具体场景的食物诉求（如"今晚想吃火锅"）——不得被采集漏斗吞成确认句
const SCENARIO_FOOD_CRAVING_REGEX = /想吃|想喝|馋|去吃|吃顿|来顿|炫|干饭|火锅|烧烤|炸鸡|奶茶|麻辣烫|烤肉|螺蛳粉|蛋糕|甜品|炸串|关东煮/;
// fix4c：非体重健康诉求（如"长痘想调理"）——接住诉求，不硬拉回减重采集
const BODY_HEALTH_CONCERN_REGEX = /长痘|痘痘|皮肤|上火|炎症|湿疹|过敏(?![；;，,。]|$)|失眠|便秘|脱发|痛经|肠胃|胃疼|胀气|口气|溃疡/;
const REMINDER_QUESTION_REGEX = /(提醒|推送|定时|通知).*(吗|嘛|么|能不能|可以)|能不能.*(提醒|推送)|可以.*(提醒|推送)/;
const SERVICE_OPTION_QUESTION_REGEX = /(有哪些|什么).*(选择|选项|模式|功能)|怎么选|两种方式|服务区别/;
const CAPABILITY_QUESTION_REGEX = /(你能帮我什么|能帮我什么|你可以帮我什么|你能帮到我什么|能帮到我什么|你会做什么|你有什么用|能做什么)/;
const MALE_SELF_DISCLOSURE_REGEX = /(?:(?:我是|本人是|我算是|性别(?:是|为)?)[^。！？]{0,8}(?:男大学生|男学生|男生|男性|男的)|(?:^|[，,。！？!?；;：:\s])(?:在校)?男大学生(?:[，,。！？!?；;：:\s]|$))/;
const WEARABLE_CALORIE_QUESTION_REGEX = /(手表[^。！？]*(等量|补回|什么意思|为什么)|不[^。！？]*按[^。！？]*手表[^。！？]*(等量|补回)|等量补回[^。！？]*(什么意思|为什么))/;
const GENERAL_QUESTION_REGEX = /[？?]|(吗|嘛|么|为什么|怎么|如何|能不能|可不可以|有没有)[。！!～~]?$/;
const GOAL_QUESTION_REGEX = /(整体感受|整体状态|整体达到|身材目标|想达到|想改善|希望达到|最想改善|达到什么样)[^。！？\n]*[？?]/;
const PURE_GREETING_REGEX = /^(?:你好|您好|嗨|哈喽|hello|hi|在吗|在么|早上好|中午好|晚上好|大家好)[～~!！。，,\s]*$/i;

const FIRST_TURN_INTRO =
  '你好～我是你的私人健康饮食管理秘书，会先了解你的真实饮食习惯，再陪你一点点找到更适合自己的吃法。';
const RESUME_PREVIOUS_QUESTION_MESSAGE = '那先来回答一下前面问你的问题～';
const EMOTIONAL_START_SCENE_QUESTION =
  '如果你愿意，我们就从最基础、最容易回答的一点开始聊聊，不用一下子说很多，好吗？你平时吃饭主要是食堂还是外卖呀？';
const FOOD_REJECTION_REGEX = /(不爱吃|不喜欢吃|不想吃|吃不惯|换一个|换掉)/;
const TASTE_PROFILE_SCENE_TRANSITION =
  '如果想让我给出的搭配更符合你的口味，还需要先聊聊你平时的饮食习惯～' +
  '我们先从最基础的开始：你平时吃饭主要是食堂还是外卖呀？';

const FALLBACK_SLOT_QUESTIONS = {
  scene: '我们先了解一下日常吃饭的场景：你平时主要吃食堂还是点外卖呀？',
  taste: '接着聊聊口味：你平时喜欢什么味道或哪些具体食物呀？',
  budget: '预算会影响日常搭配，你一顿饭大概准备多少钱呀？',
  restrictions: '饮食安全这项还需要了解一下：有没有不吃、过敏或吃了会不舒服的食物？',
  goal: '我想了解一下你的目标：这次调整饮食最希望改善什么呀？',
  exercise: '最后了解一下日常活动：你平时会做哪些运动，大概多久一次呀？',
  cafeteriaMode: CAFETERIA_MODE_QUESTION,
};

// 百炼偶尔会把承接语的冒号单独留在回复开头（例如
// “：需要避开羊肉～……”）。这种标点没有任何语义，也不是前端渲染
// 产生的；在写入对话历史前确定性清掉，避免异常文本继续污染后续轮次。
function stripOrphanLeadingColon(text) {
  return String(text || '').replace(/^[\s\uFEFF]*[：:]+\s*/u, '').trimStart();
}

function buildFallbackSlotQuestion(slotKey, userText = '') {
  const question = FALLBACK_SLOT_QUESTIONS[slotKey] || `关于“${SLOT_LABELS[slotKey]}”，方便再补充一点具体情况吗？`;
  if (isComparisonChallenge(userText)) {
    return `${buildComparisonAnswerForText(userText)}\n${question}`;
  }
  return question;
}

const RESTRICTION_REACTION_REGEX =
  /(拉肚子|腹泻|腹胀|起疹子|长痘|反胃|恶心|不舒服|不耐受|过敏)/u;
const RESTRICTION_DECLARATION_REGEX =
  /(不能吃|不吃|不碰|不要吃|需要避开|得避开|忌口|过敏|不耐受|吃了|一吃|喝了|一喝|素食|花生|芝士|奶酪|牛奶|鸡蛋|虾|蟹|贝类|芒果)/u;
const RESTRICTION_NEGATION_REGEX =
  /(没有忌口|无忌口|没有过敏|无过敏|没有不吃|什么都能吃|都不(?:吃|过敏))/u;
const RESTRICTION_SAFETY_KEYWORD_REGEX =
  /(花生|芝士|奶酪|牛奶|鸡蛋|虾|蟹|贝类|芒果|忌口|过敏|不耐受|不能吃|不吃|不碰|需要避开|得避开|拉肚子|腹泻|腹胀|起疹子|长痘|反胃|恶心|不舒服)/u;

function getNewRestrictionLabel(userText, restrictionsValue) {
  const text = String(userText || '').trim();
  if (!text || !RESTRICTION_DECLARATION_REGEX.test(text)) return null;

  const patterns = [
    /我对\s*([^，,。！？!?；;\s]{1,12})\s*(?:过敏|不耐受)/u,
    /([^，,。！？!?；;\s]{1,12}?)\s*(?:吃了|一吃|喝了|一喝)(?:就|会)?(?:拉肚子|腹泻|腹胀|起疹子|长痘|反胃|恶心|不舒服)/u,
    /(?:不能吃|不吃|不碰|不要吃|需要避开|得避开)\s*([^，,。！？!?；;\s]{1,12})/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  if (/素食/u.test(text)) return '素食';

  const stored = String(restrictionsValue || '');
  if (!stored || !RESTRICTION_REACTION_REGEX.test(text)) return null;
  const cleaned = stored
    .replace(/^(?:需要避开|不能吃|不吃|对)/u, '')
    .replace(/(?:过敏|不耐受|吃了会.*|一吃就.*)$/u, '')
    .trim();
  return cleaned || null;
}

function detectSafetySignalNeedingClarification(userText, restrictionsValue) {
  const text = String(userText || '').trim();
  const hasDietTriggerContext = /(吃了|喝了|一吃|一喝|吃后|喝后|吃完|喝完|吃就|喝就|吃(?:了)?会|喝(?:了)?会|每次吃)/.test(text);
  if (BODY_HEALTH_CONCERN_REGEX.test(text) && !hasDietTriggerContext) return null;
  if (!text || RESTRICTION_NEGATION_REGEX.test(text)) return null;
  if (!RESTRICTION_DECLARATION_REGEX.test(text) && !RESTRICTION_REACTION_REGEX.test(text)) return null;
  if (getNewRestrictionLabel(text, restrictionsValue)) return null;

  const signal = text.match(RESTRICTION_SAFETY_KEYWORD_REGEX)?.[0];
  return signal || null;
}

function buildSafetyClarificationQuestion(signal) {
  return `你刚才提到“${signal}”，是吃东西需要避开，还是过敏呀？我不太确定你的意思，先告诉我这一点就好。`;
}

function hasVisibleRestrictionAcknowledgement(text, label) {
  const value = String(text || '');
  if (!value.includes(label)) return false;
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:记下|记住|收到|明白|了解)[^。！？?\\n]{0,20}${escapedLabel}|` +
      `${escapedLabel}[^。！？?\\n]{0,16}(?:完全避开|不安排|不碰|不出现|整体排除|按素食)`,
    'u'
  ).test(value);
}

function prependRestrictionAcknowledgement({ replyText, userText, restrictionsValue, messages = [] }) {
  const label = getNewRestrictionLabel(userText, restrictionsValue);
  if (!label) return replyText;

  const alreadyAcknowledged = messages
    .filter((message) => getMessageRole(message) === 'ai')
    .some((message) => hasVisibleRestrictionAcknowledgement(getMessageText(message), label));
  if (alreadyAcknowledged || hasVisibleRestrictionAcknowledgement(replyText, label)) return replyText;

  const acknowledgement = label === '素食'
    ? '先记下：之后按素食安排～'
    : `先记下：${label}完全避开～`;
  return `${acknowledgement}${replyText}`;
}

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

function buildComparisonChallengeAnswer() {
  return (
    '任何一个通用 AI 助手都能给饮食建议，而且免费。但差别在于：它们的记忆是"聊过的谈资"——你提过减脂，它下次顺着聊；' +
    '你的档案是"白纸黑字的专属记录"——忌口、目标锚点、执行反馈、复盘节点都写在上面，每条建议都从这份记录里长出来。' +
    '它们有问必答，而我在你已偏低或要求一周减超 1 公斤时，会明确说"这个方案不能出"——负责任的代价，有时候就是得说不。' +
    '你要的是一次"回答"，还是一位"负责的教练"？'
  );
}

function buildMemoryCounterAnswer() {
  return (
    '确实，它们也有记忆。但区别在"记得之后干什么"：它们的记忆是续聊用的谈资，聊过就翻篇；你的档案是白纸黑字的专属记录——' +
    '忌口、体重曲线、目标锚点、复盘节点都写在上面，每一条建议都从这份记录里长出来，而不是顺着话头聊两句。' +
    '它们的记忆没有周期，我有结构化的复盘节点：该校准的时候，进度条不会丢。'
  );
}

function isComparisonChallenge(userText) {
  const text = String(userText || '');
  return NAMED_AI_REGEX.test(text) || COMPARISON_CHALLENGE_REGEX.test(text) || PRICE_CHALLENGE_REGEX.test(text);
}

function isMemoryAttack(userText) {
  const text = String(userText || '');
  return MEMORY_ATTACK_REGEX.test(text) || (NAMED_AI_REGEX.test(text) && /(记忆|记得|记住)/.test(text));
}

function buildComparisonAnswerForText(userText) {
  return isMemoryAttack(userText)
    ? buildMemoryCounterAnswer()
    : buildComparisonChallengeAnswer();
}

function getFixedProductAnswer(userText) {
  const comparisonHit = NAMED_AI_REGEX.test(userText) || COMPARISON_CHALLENGE_REGEX.test(userText);
  if (comparisonHit) {
    return isMemoryAttack(userText) ? buildMemoryCounterAnswer() : buildComparisonChallengeAnswer();
  }
  if (PRICE_CHALLENGE_REGEX.test(userText)) return buildComparisonChallengeAnswer();
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

// 不枚举“最后想问/最后再确认/还差最后一个”等具体句式：模型可以无限
// 换说法。状态仍缺两项以上时，“最后”本身或“还/只差一个”就已经与
// 事实冲突，直接按语义核心做确定性判断。
const FINAL_QUESTION_PROGRESS_REGEX =
  /最后|(?:还|只)(?:差|剩)(?:下)?[^。！？\n]{0,4}(?:一个|一项)/u;

function getRemainingCollectionSlotKeys(slots = {}) {
  const remaining = SLOT_KEYS.filter((key) => !slots[key]?.confirmed);
  const sceneIsCafeteria = slots.scene?.confirmed && String(slots.scene.value || '').includes('食堂');
  if (sceneIsCafeteria && !slots.cafeteriaMode?.confirmed) remaining.push('cafeteriaMode');
  return remaining;
}

// 是否只剩最后一项由状态机判断，不能让模型自行估算。只要实际仍缺两项
// 或更多，任何“最后一个/还差最后一个”播报都属于确定性矛盾，必须重试；
// 即使提示词偶尔失守，也不能把错误进度写进对话历史。
function detectMisleadingCollectionProgress(text, slots = {}) {
  const remaining = getRemainingCollectionSlotKeys(slots);
  if (remaining.length <= 1 || !FINAL_QUESTION_PROGRESS_REGEX.test(String(text || ''))) return [];
  return [{
    type: 'misleading_collection_progress',
    detail:
      `回复声称正在问“最后一个”问题，但状态机显示仍有${remaining.length}项未确认：` +
      remaining.map((key) => SLOT_LABELS[key]).join('、'),
  }];
}

function detectCollectionVerbosity(text, opts = {}) {
  if (opts.skipVerbosity) return [];
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

// 模型有时会在自然承接的“记下啦”摘要里，顺手补出用户从未回答过的值。
// 例如 exercise 仍为空时写成“暂不运动”。这比问错下一项更隐蔽：状态层
// 没有真的保存假值，但用户已经被告知“系统记下了”，后续对话会自相矛盾。
// 只检查带有“已记录/当前情况”语气的陈述句，避免把问题中的举例
// （如“目前没运动也可以直接说”）误判成编造。
const UNCONFIRMED_SLOT_ASSERTION_PATTERNS = {
  scene: /(主要吃|平时吃|就餐场景[^，。；]*)(食堂|外卖|自己做饭)/,
  cafeteriaMode: /(食堂[^，。；]{0,12})(自选|自己选菜|固定套餐)/,
  taste: /(喜欢|爱吃|偏爱|口味)(?:[^，。；]{0,18})/,
  budget: /(预算|一顿|每顿)[^，。；]{0,10}\d+(?:\.\d+)?\s*元/,
  restrictions: /(没有忌口|无忌口|没有过敏|无过敏|没有不吃|什么都能吃)/,
  goal: /(目标是|目标为|希望改善|想要达到|想减脂|想塑形|想增肌)/,
  exercise: /(暂不运动|目前不运动|现在不运动|没有运动|不怎么运动|基本不运动|每周[^，。；]{0,16}(跑步|健身|攀岩|打球|游泳))/,
};

const RECORDED_ASSERTION_TONE_REGEX = /(记下|记录|收到|了解到|目前情况|当前情况|你的情况|信息是|档案|我知道了)/;

function detectUnconfirmedSlotAssertions(text, slots = {}) {
  const statements = String(text || '')
    .split(/(?<=[。！!\n])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/[？?]/.test(part) && RECORDED_ASSERTION_TONE_REGEX.test(part));

  const violations = [];
  for (const [slotKey, pattern] of Object.entries(UNCONFIRMED_SLOT_ASSERTION_PATTERNS)) {
    if (slots[slotKey]?.confirmed) continue;
    const sentence = statements.find((part) => pattern.test(part));
    if (sentence) {
      violations.push({
        type: 'asserts_unconfirmed_slot',
        detail: `用户尚未确认“${SLOT_LABELS[slotKey]}”，回复却在已记录摘要里把它陈述成事实：${sentence}`,
      });
    }
  }
  return violations;
}

// 正则命中的几类是已经验证过的快速通道，不用等一次模型调用就能拦下来；
// 但真实测试证明模型总能找到没被枚举到的新说法绕过去，所以这里加上
// checkAsksTargetSlot 兜底——不管正则有没有命中，都再问一遍"这段话到底
// 有没有实质问到目标字段"，这条判断跟具体措辞无关，理论上能覆盖所有
// 未来可能出现的新规避方式，不用再靠不断新增正则去追。
async function detectAskNextQuestionViolations(text, slotLabel, slotKey, slots = {}, opts = {}) {
  const violations = [
    ...detectPrematurePlan(text),
    ...detectCollectionVerbosity(text, opts),
    ...detectUnconfirmedSlotAssertions(text, slots),
    ...detectMisleadingCollectionProgress(text, slots),
  ];
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
  const lastUserMessage = [...state.messages].reverse().find((m) => getMessageRole(m) === 'human');
  const lastUserText = lastUserMessage ? getMessageText(lastUserMessage) : '';

  // 身体不适确定性出口（情绪链刀1c 手术 E）：用户当前消息在表达即时身体
  // 不适时，采集确定性分支（cafeteriaMode 等）不得抢先消费——人不舒服时
  // 教练不会追着问食堂自选还是套餐。真忌口声明（detectSafetySignal...
  // 返回非空）仍优先走安全澄清，本出口不抢。
  const hasHealthConcernText = BODY_HEALTH_CONCERN_REGEX.test(lastUserText);
  const healthConcernSafetySignal = hasHealthConcernText
    ? detectSafetySignalNeedingClarification(lastUserText, state.slots?.restrictions?.value)
    : null;
  if (hasHealthConcernText && !healthConcernSafetySignal) {
    const healthConcernResponse = await model.invoke([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content:
          '用户这一轮在表达身体上的不舒服（可能是吃了某样东西之后出现的）。这一轮唯一要做的是关心 TA 的身体：' +
          '结合 TA 刚说的情况，给一两句具体、可执行的饮食方向（例如喝温水、吃清淡好消化的、暂停油腻辛辣刺激），' +
          '并提醒持续不适或加重时及时就医。语气像一位关心 TA 的教练，自然、简短，不评判、不说教。\n' +
          '【严格禁止】这一轮不向用户提任何问题（任何形式的确认、追问、信息收集都不行），' +
          '不做与当下不适无关的饮食建档，不提前给完整饮食方案，也不重复空洞的安慰套话。\n' +
          '回复以关心的陈述收尾即可，不需要以问句结束。',
      },
      ...state.messages,
    ]);
    const healthConcernReply = String(healthConcernResponse.content || '').trim();
    return {
      messages: [{ role: 'ai', content: healthConcernReply }],
      lastAskedSlot: state.lastAskedSlot || nextSlot,
      ...(state.resumePreviousQuestion ? { resumePreviousQuestion: false } : {}),
      ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
      ...(state.directQuestionAnsweredThisTurn ? { directQuestionAnsweredThisTurn: false } : {}),
    };
  }

  if (nextSlot === 'cafeteriaMode') {
    const resumeMessage = state.resumePreviousQuestion ? RESUME_PREVIOUS_QUESTION_MESSAGE : null;
    const sceneValue = state.slots?.scene?.value || '';
    const cafeteriaQuestion = sceneValue.includes('食堂') && sceneValue.includes('外卖')
      ? `明白，平时食堂和外卖会穿插着吃，我记下了～${CAFETERIA_MODE_QUESTION}`
      : CAFETERIA_MODE_QUESTION;
    const safetySignal = detectSafetySignalNeedingClarification(
      lastUserText,
      state.slots?.restrictions?.value
    );
    const safeCafeteriaQuestion = safetySignal
      ? buildSafetyClarificationQuestion(safetySignal)
      : prependRestrictionAcknowledgement({
        replyText: cafeteriaQuestion,
        userText: lastUserText,
        restrictionsValue: state.slots?.restrictions?.value,
        messages: state.messages,
      });
    return {
      messages: [
        resumeMessage,
        state.emotionalSupportDeliveredThisTurn
          ? `如果你愿意，我们就从眼前最容易回答的一点继续聊聊，好吗？${safeCafeteriaQuestion}`
          : safeCafeteriaQuestion,
      ]
        .filter(Boolean)
        .map((content) => ({ role: 'ai', content })),
      lastAskedSlot: nextSlot,
      ...(resumeMessage ? { resumePreviousQuestion: false } : {}),
      ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
      ...(state.directQuestionAnsweredThisTurn ? { directQuestionAnsweredThisTurn: false } : {}),
    };
  }

  const safetySignal = detectSafetySignalNeedingClarification(
    lastUserText,
    state.slots?.restrictions?.value
  );
  if (safetySignal) {
    const isFirstTurn = isFirstConversationTurn(state.messages);
    return {
      messages: [
        isFirstTurn ? FIRST_TURN_INTRO : null,
        buildSafetyClarificationQuestion(safetySignal),
      ]
        .filter(Boolean)
        .map((content) => ({ role: 'ai', content })),
      lastAskedSlot: nextSlot,
      ...(state.resumePreviousQuestion ? { resumePreviousQuestion: false } : {}),
      ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
      ...(state.directQuestionAnsweredThisTurn ? { directQuestionAnsweredThisTurn: false } : {}),
    };
  }

  const emojiOnly = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s)+$/u.test(lastUserText.trim());
  if (emojiOnly) {
    return {
      messages: [{
        role: 'ai',
        content: '这个表情是想表达什么意思呀？你可以直接告诉我，是同意、不同意，还是想补充别的。',
      }],
      // 保留当前等待字段；用户解释后仍应回答同一个问题，不能向后跳。
      lastAskedSlot: state.lastAskedSlot || nextSlot,
    };
  }
  const fixedProductAnswer = getFixedProductAnswer(lastUserText);
  const isFirstTurn = isFirstConversationTurn(state.messages);
  if (fixedProductAnswer) {
    // fix4c-4：固定话术命中 → 整轮确定性。
    // directQuestion 已单独出话术气泡（directQuestionAnsweredThisTurn）时不重复出话术；
    // 采集问句直接用固定模板，不让模型生成——模型采集会漂移措辞（F1/F2/F3 不逐字一致）、
    // 编造用户目标（F2"听到你想减脂"）、复述已答观点（F4 双答）。
    const questionBubble =
      FALLBACK_SLOT_QUESTIONS[nextSlot] ||
      `关于"${SLOT_LABELS[nextSlot]}"，方便再补充一点具体情况吗？`;
    const bubbles = [];
    if (isFirstTurn) bubbles.push(FIRST_TURN_INTRO);
    if (!state.directQuestionAnsweredThisTurn) bubbles.push(fixedProductAnswer);
    bubbles.push(questionBubble);
    return {
      messages: bubbles.map((content) => ({ role: 'ai', content })),
      lastAskedSlot: nextSlot,
      ...(state.directQuestionAnsweredThisTurn ? { directQuestionAnsweredThisTurn: false } : {}),
      ...(state.resumePreviousQuestion ? { resumePreviousQuestion: false } : {}),
      ...(state.emotionalSupportDeliveredThisTurn ? { emotionalSupportDeliveredThisTurn: false } : {}),
    };
  }
  // fix4d-2b：原条件 isFirstTurn 依赖 isFirstConversationTurn()（要求
  // aiCount===0），但图的第一个节点 provideEmotionalSupport 在首轮就
  // 会把 FIRST_TURN_INTRO 作为 ai 消息写入 state.messages，导致该条件
  // 在本节点永远为 false——这个纯寒暄确定性分支自 fix4c-3 起从未触发
  // 过，"你好"实际一直走模型路径（双稳态：fix4c-4 碰巧带问句、fix4d-2
  // 翻成抄示例无问句，见测试记录-2026-09-02-fix4d-2/fix4d-2b）。
  // 改为按"用户只说过一句话"判定首轮；介绍已由上游发出则不重复，
  // 未发出（防御分支，当前图结构下不可达）则带上。
  const humanTurnCount = state.messages.filter(
    (message) => getMessageRole(message) === 'human'
  ).length;
  const introAlreadySent = state.messages.some(
    (message) =>
      getMessageRole(message) === 'ai' &&
      getMessageText(message) === FIRST_TURN_INTRO
  );
  if (humanTurnCount === 1 && PURE_GREETING_REGEX.test(lastUserText.trim())) {
    const greetingReply =
      '你好呀～我刚开始了解你的饮食习惯，先从最简单的开始：你平时吃饭主要是食堂还是外卖呀？';
    return {
      messages: [{
        role: 'ai',
        content: introAlreadySent
          ? greetingReply
          : FIRST_TURN_INTRO + '\n' + greetingReply,
      }],
      lastAskedSlot: nextSlot,
    };
  }
  const hasGeneralQuestion = GENERAL_QUESTION_REGEX.test(lastUserText.trim());
  const hasScenarioCraving = SCENARIO_FOOD_CRAVING_REGEX.test(lastUserText);
  const hasHealthConcern = BODY_HEALTH_CONCERN_REGEX.test(lastUserText);
  const hasPriceChallenge = PRICE_CHALLENGE_REGEX.test(lastUserText);
  const hasCounterArgument = COUNTER_ARGUMENT_REGEX.test(lastUserText);
  const hasUnknownAiComparison = UNKNOWN_AI_COMPARISON_REGEX.test(lastUserText);

  let sideAnswer = null;
  if (!state.directQuestionAnsweredThisTurn && hasGeneralQuestion && !fixedProductAnswer) {
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
    (sideAnswer
      ? `用户本轮的问题已由另一条消息单独回答过了（内容：${sideAnswer}）。你生成的这部分绝不允许重复、转述或引申其核心观点，直接继续问目标字段。\n\n`
      : '') +
    (fixedProductAnswer
      ? '用户这一轮还顺带问了产品功能、提醒、收费或服务选项问题，这部分会由外部代码用固定产品话术回答。' +
        '你生成的内容里不要重复回答产品问题，只继续完成本轮缺失信息的提问。\n\n'
      : hasGeneralQuestion
        ? '用户这一轮还提出了一个其他问题，这部分会由外部流程先单独回答。你不要重复回答，' +
          '这里只继续完成本轮缺失信息的提问。\n\n'
        : '') +
    (hasPriceChallenge
      ? '用户这一轮在质疑收费/拿免费 AI 对比（如"免费你凭什么收钱""为什么收费"）。先按第 51 条三段式话术正面回应这个质疑（承认→拆差别→收尾），回应完再自然回归本轮采集项；不得装作没听见继续问缺失项。\n\n'
      : '') +
    (hasCounterArgument
      ? '用户本轮在反驳/质疑你上一轮的回复（带"也有/但是/那又"等语气，如"豆包也有记忆啊"）。先正面回应 TA 的关切：涉及免费 AI 对比按第 51 条三段式（差异落在"记得之后干什么"，不说"它们不记得你"），涉及跟踪/边界按第 52、53 条；回应完再自然回归本轮采集项；不得装作没听见继续问缺失项。\n\n'
      : '') +
    (hasUnknownAiComparison
      ? '用户提了一个你没听过的 AI 产品/助手/大模型（或"那个什么助手"这类指代）在对比。只要语义是"它也能做到/它免费/它也有记忆/凭什么用你"，一律先按第 51 条三段式正面回应（承认→拆差别→收尾），再问采集项；名字陌生不许忽略、不许反问"你说的是什么"。\n\n'
      : '') +
    (hasScenarioCraving || hasHealthConcern
      ? '用户这一轮带了一个具体的饮食/身体诉求，不是对采集问题的正面回答。先接住它：' +
        (hasScenarioCraving
          ? '回复必须包含三部分、按顺序连成一段：①一句接住（不否定想吃的意愿）；②至少一个具体判断依据（点出更值得吃的选择或吃法，如锅底/配菜/蘸料怎么挑，或吃完这一顿怎么调）；③一句本轮采集项问句。三部分缺一即不合格；'
          : '接住诉求，给 1~2 句可执行的饮食方向，不评判、不硬拉回减重采集。') +
        '然后再自然问出本轮目标项。禁止只回一句"好的记下了/明白你想吃XX"就继续问。' +
        '注意：接住诉求 ≠ 出方案，完整方案依然禁止。\n\n'
      : '') +
    '【严格禁止】这一轮唯一的任务就是问出这一项缺失的信息，绝对不能在这一轮' +
    '提前给出任何具体的饮食方案、菜品推荐、分量建议——哪怕你觉得已经确认的' +
    '信息看起来已经足够多、已经能大概判断出方案该怎么搭，也必须忍住不要提前' +
    '给。是否已经可以出方案，这个判断已经由外部状态机做出了明确结论（现在' +
    `的结论是"还不能出方案，当前需要先补充${slotLabel}这一项"），不是由你自己根据` +
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
  const skipVerbosity = hasPriceChallenge || hasCounterArgument || hasScenarioCraving || hasHealthConcern;

  for (let attempt = 0; attempt <= MAX_PREMATURE_PLAN_RETRIES; attempt += 1) {
    const extraInstruction =
      attempt === 0 ? null : buildPrematurePlanRetryInstruction(prematurePlanViolations, slotLabel, replyText);
    // eslint-disable-next-line no-await-in-loop
    const result = await generateOnce(extraInstruction);
    replyText = stripOrphanLeadingColon(result.text);
    // eslint-disable-next-line no-await-in-loop
    prematurePlanViolations = await detectAskNextQuestionViolations(
      replyText,
      slotLabel,
      nextSlot,
      state.slots,
      { skipVerbosity }
    );

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
    const safetySignal = detectSafetySignalNeedingClarification(
      lastUserText,
      state.slots?.restrictions?.value
    );
    replyText = safetySignal
      ? buildSafetyClarificationQuestion(safetySignal)
      : buildFallbackSlotQuestion(nextSlot, lastUserText);
  }

  replyText = normalizeFoodRejectionTransition(replyText, lastUserText, nextSlot);
  replyText = prependRestrictionAcknowledgement({
    replyText,
    userText: lastUserText,
    restrictionsValue: state.slots?.restrictions?.value,
    messages: state.messages,
  });

  // 第一项尚未真正收到任何资料时不能说“记下啦”，否则像把固定模板
  // 生硬贴在问题前面。只清理首次场景问题，不影响后续真实的承接确认。
  if (nextSlot === 'scene') {
    replyText = replyText.replace(/^(?:好嘞|好)[，,]?\s*记下啦[～~]?[，,]?\s*/u, '');
  }

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
    ...(state.directQuestionAnsweredThisTurn ? { directQuestionAnsweredThisTurn: false } : {}),
  };
}

module.exports = {
  askNextQuestion,
  CAFETERIA_MODE_QUESTION,
  checkAsksTargetSlot,
  detectAskNextQuestionViolations,
  FIRST_TURN_INTRO,
  buildFallbackSlotQuestion,
  RESUME_PREVIOUS_QUESTION_MESSAGE,
  EMOTIONAL_START_SCENE_QUESTION,
  CAPABILITY_ANSWER,
  MALE_SERVICE_BOUNDARY_ANSWER,
  MALE_SELF_DISCLOSURE_REGEX,
  WEARABLE_CALORIE_ANSWER,
  MAX_COLLECTION_QUESTION_LENGTH,
  detectCollectionVerbosity,
  detectUnconfirmedSlotAssertions,
  getFixedProductAnswer,
  isFirstConversationTurn,
  composeReplyMessages,
  normalizeFoodRejectionTransition,
  TASTE_PROFILE_SCENE_TRANSITION,
  stripOrphanLeadingColon,
  getRemainingCollectionSlotKeys,
  detectMisleadingCollectionProgress,
  getNewRestrictionLabel,
  hasVisibleRestrictionAcknowledgement,
  prependRestrictionAcknowledgement,
  detectSafetySignalNeedingClarification,
  buildSafetyClarificationQuestion,
  NAMED_AI_REGEX,
  COMPARISON_CHALLENGE_REGEX,
  MEMORY_COUNTER_REGEX,
  PRICE_CHALLENGE_REGEX,
  buildComparisonChallengeAnswer,
  buildMemoryCounterAnswer,
  isComparisonChallenge,
  isMemoryAttack,
};

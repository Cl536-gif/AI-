// 信息抽取节点：判断用户这一轮消息里，六项信息各自有没有新的候选值。
// 这是其他节点（冲突检测、完整性判断、出方案）的基础——只有先把
// "这一轮用户到底说了什么"结构化抽取出来，后面的状态更新/路由才有依据。
const { z } = require('zod');
const { classifierModel } = require('../model');
const { SLOT_KEYS, SLOT_LABELS, TRACKED_SLOT_KEYS } = require('../state');
const { getMessageText, findLastUserMessage } = require('../utils/messages');
const { recognizeDish } = require('../../data/commonDishCatalog');

const extractionSchema = z.object({
  scene: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"就餐场景"信息，只能是"食堂"或"外卖"这两个类别' +
        '本身、或者明确的同义表达（比如"食堂打饭""叫外卖""点外卖"）。\n' +
        '特别注意：像"自选""固定套餐""自己选菜"这类词属于 cafeteriaMode，' +
        '不能把这些词本身当成对 scene 的重新表述或修正；但用户说"我们食堂是' +
        '固定套餐"这类完整表达时，scene 应填"食堂"，cafeteriaMode 同时记录。\n' +
        '如果这一轮消息完全没涉及场景信息，同样填 null，不要凭空猜测或沿用' +
        '旧值。'
    ),
  cafeteriaMode: z
    .string()
    .nullable()
    .describe(
      '这一轮用户新提供的食堂打饭方式。能自己到窗口挑选主食和菜，统一记录为' +
        '"自己挑菜"；窗口已经搭配好整份套餐、用户只能拿现成组合，统一记录为' +
        '"固定套餐"。只有用户明确说了这层意思，或者上一轮正在问食堂打饭方式' +
        '而用户用"自选""固定的"这类短回答作答时才填写；没有依据就填 null。' +
        '它是独立后台字段，绝不能塞进 scene、taste 或 budget。'
    ),
  taste: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"口味偏好"信息，指用户喜欢/爱吃的口味。必须用' +
        '完整的、自带"喜欢/偏好"语义的说法记录（比如"喜欢辣""偏麻辣口味"），' +
        '不能只存一个孤立的关键词（比如只存"辣"）——孤立的关键词后续没法分辨' +
        '这到底是"喜欢"还是"忌口要避开"，必须让存进去的这句话本身就说清楚是' +
        '哪一种。如果这一轮消息完全没涉及这个信息，填 null。'
    ),
  budget: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"预算"信息，只有在语境明确支持的情况下才能把' +
        '一个孤立数字理解成预算——比如上一轮问的就是预算，或者对话历史里已经' +
        '在聊预算相关的话题，这种情况下才把数字整理成"每顿XX元"这种表述' +
        '（比如"20"填成"每顿20元左右"）。如果消息里只有一个孤立数字、且完全' +
        '没有任何上下文线索能确定这是在说预算（比如上一轮问的根本不是预算，' +
        '对话历史里也没聊过预算话题），绝对不能凭空猜测这是预算，必须填 null，' +
        '哪怕这个数字看起来"像"是个预算数字也不行——没有语境支撑就不能填。' +
        '如果这一轮消息完全没涉及这个信息，同样填 null。'
    ),
  restrictions: z
    .string()
    .nullable()
    .describe(
      '这一轮用户消息里新提供的"忌口/过敏"信息。必须用完整的、自带"要避开"' +
        '语义的说法记录（比如"不吃辣""对牛奶过敏""吃芝士会拉肚子"），不能只存' +
        '一个孤立的关键词（比如只存"辣"）——孤立的关键词后续没法分辨这到底是' +
        '"喜欢吃"还是"要避开"，必须让存进去的这句话本身就说清楚这是一项要避开' +
        '的食物/反应。如果这一轮消息完全没涉及这个信息，填 null。'
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
      '这一轮用户消息里新提供的"是否运动"信息。必须用完整的说法记录（比如' +
        '"不运动""偶尔运动""经常跑步"），不能丢掉否定词只存一个孤立的关键词' +
        '（比如把"不运动"简化成只存"运动"，意思会正好相反）。如果这一轮消息' +
        '完全没涉及这个信息，填 null。'
    ),
});

const structuredModel = classifierModel.withStructuredOutput(extractionSchema, {
  name: 'extract_slots',
});

const NO_RESTRICTION_REGEX = /^(没有|没有忌口|没忌口|不过敏|无|都可以|都能吃|没有什么)[。！!～~]?$/;
const PRODUCT_QUESTION_PART_REGEX = /(你)?(这里|这个|这些|饮食建议)?(需要|要)?(付费|收费|花钱)(吗|嘛|么)?|免费吗|多少钱/g;
const VAGUE_RESTRICTION_ANSWER_REGEX = /^(不知道|不清楚|想不到|没有想好|随便)$/;
const VAGUE_GOAL_ANSWER_REGEX = /^(不知道|不清楚|想不到|没有想好|没想好|没有|没什么|随便|都行)$/;
const GENERIC_CONFIRMATION_ANSWER_REGEX = /^(?:是的?|对(?:的)?|嗯+|哦+|好(?:的)?|可以|没错|yes|yep|yeah)[呀啊哈呢吧嘛～~！!。.]?$/i;
const EMOJI_ONLY_REGEX = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s)+$/u;
const GOAL_NORMALIZATION_RULES = [
  { regex: /^(精气神|有精气神|更有精气神|精神点|更精神)$/, value: '希望更有精气神' },
  { regex: /^(不犯困|少犯困|没那么困|精力好|精力充沛)$/, value: '希望精力更稳定、不容易犯困' },
  { regex: /^(轻盈|轻快|轻松点|身体轻一点)$/, value: '希望身体状态更轻盈' },
  { regex: /^(穿衣好看|穿衣更好看|穿衣合身|衣服更合身)$/, value: '希望穿衣更合身、更好看' },
  { regex: /^(上镜|拍照好看|拍照更好看)$/, value: '希望拍照更上镜' },
];

// 用户正在正面回答忌口问题时，"芝士花生"这类简短食物名已经是有效
// 回答，不能因为缺少"不吃/过敏"字样就丢弃。若同一句还顺带问了收费，
// 先移除产品问题部分，再保留剩余食物答案。
function normalizeRestrictionFromContext({ userText, lastAskedSlot, extractedValue }) {
  if (extractedValue || lastAskedSlot !== 'restrictions') return extractedValue;

  const answerPart = userText
    .replace(PRODUCT_QUESTION_PART_REGEX, '')
    .replace(/^[，,。！？!?；;：:\s]+|[，,。！？!?；;：:\s]+$/g, '')
    .trim();
  if (!answerPart || answerPart.length > 40 || VAGUE_RESTRICTION_ANSWER_REGEX.test(answerPart)) return null;
  if (NO_RESTRICTION_REGEX.test(answerPart)) return '没有忌口或已知过敏';
  return `需要避开${answerPart}`;
}

// 身材/状态目标的自然表达非常开放，不能靠穷举词表才能识别。上一轮明确
// 正在问goal时，用户给出的简短实质回答本身就是最强语境；模型偶尔没有
// 抽出来时，用用户原话兜底。少量高频表达只做无损规范化，未知新说法仍
// 保留原话，不替用户扩写成减脂、塑形等没有说过的目标。
function normalizeGoalFromContext({ userText, lastAskedSlot, extractedValue }) {
  const answer = String(extractedValue || userText)
    .replace(/^[，,。！？!?；;：:\s]+|[，,。！？!?；;：:\s]+$/g, '')
    .trim();
  if (!answer) return extractedValue;
  if (!extractedValue && lastAskedSlot !== 'goal') return null;

  const normalizedRule = GOAL_NORMALIZATION_RULES.find((rule) => rule.regex.test(answer));
  if (normalizedRule) return normalizedRule.value;
  if (extractedValue) return extractedValue;
  if (lastAskedSlot !== 'goal' || answer.length > 30 || VAGUE_GOAL_ANSWER_REGEX.test(answer)) return null;
  return answer;
}

function normalizeTasteFromContext({ userText, lastAskedSlot, extractedValue }) {
  if (lastAskedSlot !== 'taste') return { value: extractedValue, reason: null };
  const rawAnswer = String(userText || '')
    .replace(/^[，,。！？!?；;：:\s]+|[，,。！？!?；;：:\s]+$/g, '')
    .trim();
  // “是的/对/emoji”只能回答一个明确的确认问题，不能本身成为口味值。
  // 之前这里会把“是的”兜底成“喜欢是的”，污染后续长期档案。
  if (GENERIC_CONFIRMATION_ANSWER_REGEX.test(rawAnswer) || EMOJI_ONLY_REGEX.test(rawAnswer)) {
    return { value: null, reason: null };
  }
  const dish = recognizeDish(userText);
  if (!dish) {
    if (extractedValue) return { value: extractedValue, reason: null };
    const answer = String(userText || '')
      .replace(/^[，,。！？!?；;：:\s]+|[，,。！？!?；;：:\s]+$/g, '')
      .trim();
    const vague = /^(不知道|不清楚|想不到|没有|没什么|随便|都行|口味|口味偏好)$/;
    // 上一轮明确在问口味时，具体食物名本身就是有效回答。菜品库只负责
    // 补充可选的口味推断，不再决定“香蕉飞饼”“煎饼”等答案能否落档。
    if (answer && answer.length <= 30 && !vague.test(answer) && !/[？?]/.test(answer)) {
      return { value: `喜欢${answer}`, reason: null };
    }
    return { value: null, reason: null };
  }

  if (dish.tasteInference) {
    return {
      value: `喜欢${dish.canonicalName}，可能偏好${dish.tasteInference.value}口味`,
      reason: {
        type: 'dish_flavor_inference',
        dishName: dish.canonicalName,
        inferredTaste: dish.tasteInference.value,
      },
    };
  }

  // 菜名本身就是有效偏好，但没有足够稳定的口味标签时只记录喜欢该菜，
  // 不擅自推断清淡、酸甜或辛辣。
  return { value: `喜欢${dish.canonicalName}`, reason: null };
}

function normalizeExerciseFromContext({ userText, lastAskedSlot, extractedValue }) {
  if (lastAskedSlot !== 'exercise') return extractedValue;
  const answer = String(userText || '').trim();
  if (/^(?:没有|没|无|不运动|没有运动|没运动|基本不动|不怎么运动)[。！!～~]?$/.test(answer)) {
    return '目前没有运动';
  }
  return extractedValue;
}

// 真实测试里稳定复现过的错误：用户只回了某一项的"类别名称/话题词"本身
// （比如问预算，用户只回"预算"两个字），模型会把这个词原样当成该字段的
// 值填进去。这种情况光靠 prompt 描述没能稳定纠正（同一测试连续多次复现），
// 所以在代码层面做确定性兜底——候选值如果精确匹配这份黑名单，直接当作
// 无效丢弃，不依赖模型自觉遵守。
const BARE_LABEL_BLOCKLIST = {
  scene: ['场景', '就餐场景', '吃饭场景', '就餐场景（食堂/外卖）'],
  taste: ['口味', '口味偏好', '偏好'],
  budget: ['预算'],
  restrictions: ['忌口', '过敏', '忌口过敏', '忌口/过敏'],
  goal: ['身材目标', '目标', '身材'],
  exercise: ['运动', '是否运动', '运动情况'],
  cafeteriaMode: ['打饭方式', '食堂打饭方式'],
};

function isBareLabelEcho(key, value) {
  if (!value) return false;
  return (BARE_LABEL_BLOCKLIST[key] || []).includes(value.trim());
}

// 真实测试里稳定复现过的另一种错误（5次里5次都复现，不是偶发）：
// 用户在零上下文的情况下只回一个孤立数字（比如就打了个"20"，上一轮
// AI根本没问预算，对话历史也完全没聊过预算），budget 的 schema 描述
// 里已经明确写了"没有语境支撑就不能填"，但模型还是会把孤立数字硬猜
// 成预算——这跟字段名回声是同一类"光靠 prompt 描述没能稳定纠正"的
// 问题，用同样的思路做代码层面确定性兜底：如果用户这一轮的原始消息
// 掐头去尾之后就是一个孤立数字（没有任何"元""块""预算"这类附带
// 词），且上一轮 AI 问的不是预算本身，那不管模型抽取出了什么，budget
// 候选值一律丢弃，不依赖模型自觉遵守这条边界。
const BARE_NUMBER_REGEX = /^\d+(\.\d+)?$/;
const CAFETERIA_SCENE_EVIDENCE_REGEX = /(食堂|饭堂|打饭|校内(?:吃饭|就餐)|学校(?:里|内)(?:吃饭|就餐))/;
const TAKEOUT_SCENE_EVIDENCE_REGEX = /(外卖|点餐|叫餐|送餐)/;
const BOTH_SCENES_CONTEXT_ANSWER_REGEX = /^(?:两个|两种|这两个|也)?都(?:会|了|也)?(?:吃|有|可以|行|用|点|去)|^(?:换着|混着|穿插着|交替着)吃|^(?:食堂|饭堂)(?:和|跟|、)?外卖(?:都)?(?:会)?(?:吃|有|用|点)|^外卖(?:和|跟|、)?(?:食堂|饭堂)(?:都)?(?:会)?(?:吃|有|用|点)/;

// 场景证据必须是"肯定要去吃"的事实，不能只看词面出现——"食堂不去"、
// "不吃外卖"这类否定句不是证据。子句级判定：任一分句里场景词与否定词
// 同现即视为该分句否定该场景；只要有一个分句肯定该场景即算有正证据。
// 采集兜底（applyDeterministicExplicitCandidates）与合理性校验
// （isUnsupportedSceneGuess）共用同一判定，防止只改一道门、水从另一道流走。
function hasPositiveSceneEvidence(text, sceneType) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const clauses = raw
    .split(/[，,。！？!?；;：:\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const evidenceRegex =
    sceneType === 'cafeteria' ? CAFETERIA_SCENE_EVIDENCE_REGEX : TAKEOUT_SCENE_EVIDENCE_REGEX;
  for (const clause of clauses) {
    if (!evidenceRegex.test(clause)) continue;
    if (/(不|没|别|不用|算了|免了|戒了)/.test(clause)) continue; // 否定句不构成正证据
    return true;
  }
  return false;
}

function normalizeSceneFromContext({ userText, lastAskedSlot, extractedValue }) {
  const answer = String(userText || '')
    .replace(/^[，,。！？!?；;：:\s]+|[，,。！？!?；;：:\s]+$/g, '')
    .trim();
  if (lastAskedSlot === 'scene' && BOTH_SCENES_CONTEXT_ANSWER_REGEX.test(answer)) {
    return '食堂和外卖都会吃';
  }
  return extractedValue;
}

function isUnsupportedSceneGuess(key, candidateValue, userText, lastAskedSlot) {
  if (key !== 'scene') return false;
  const text = userText.trim();
  if (lastAskedSlot === 'scene' && BOTH_SCENES_CONTEXT_ANSWER_REGEX.test(text)) return false;
  if (candidateValue.includes('食堂')) {
    if (hasPositiveSceneEvidence(text, 'cafeteria')) return false;
    if (lastAskedSlot === 'scene' && /^(学校|校内|学校吃|在学校吃)[。！!～~]?$/.test(text)) return false;
    return true;
  }
  if (candidateValue.includes('外卖')) {
    return !hasPositiveSceneEvidence(text, 'takeout');
  }
  return true;
}

function isUnsupportedBareNumberBudgetGuess(key, userText, lastAskedSlot) {
  if (key !== 'budget') return false;
  if (lastAskedSlot === 'budget') return false; // 上一轮就是在问预算，这是合理语境
  return BARE_NUMBER_REGEX.test(userText.trim());
}

// 模型在长句同时包含多项资料时，偶尔会漏掉非常明确的“没有忌口”或
// “每周跑步两次”。这些表达不需要语义推断，用确定性规则补齐；只在
// 模型没有给出该字段时生效，不覆盖模型已经抽取出的更完整内容。
function applyDeterministicExplicitCandidates(extracted, userText) {
  const result = { ...extracted };
  const text = String(userText || '').trim();

  if (!result.scene) {
    const likesCafeteria = hasPositiveSceneEvidence(text, 'cafeteria');
    const likesTakeout = hasPositiveSceneEvidence(text, 'takeout');
    if (likesCafeteria && likesTakeout) {
      result.scene = '食堂和外卖都会吃';
    } else if (likesCafeteria) {
      result.scene = '食堂';
    } else if (likesTakeout) {
      result.scene = '外卖';
    }
  }

  if (/(食堂|饭堂)[^。！？\n]{0,15}(?:自选|自己挑|自由选)/.test(text)) result.cafeteriaMode = '自己挑菜';
  else if (/(食堂|饭堂)[^。！？\n]{0,15}(?:固定套餐|配好的套餐)/.test(text)) result.cafeteriaMode = '固定套餐';

  const budget = text.match(/(?:每顿|一顿|预算)[^。！？\n]{0,8}?(\d+(?:\.\d+)?)\s*(元|块钱|块)/);
  if (budget) result.budget = `每顿${budget[1]}元`;

  if (/(?:没有|没|无)(?:任何|什么|已知)?(?:忌口|过敏)/.test(text)) {
    result.restrictions = '没有忌口或已知过敏';
  } else {
    const restriction = text.match(/(?:不吃|不喝|对[^，,。！？\n]{1,12}过敏|吃[^，,。！？\n]{1,12}(?:会|就)(?:腹泻|拉肚子|腹胀|发痒|起疹))/);
    if (restriction) result.restrictions = restriction[0];
  }

  const goal = text.match(/(?:目标(?:是|想)?|想要?|希望)?\s*(减脂|减肥|塑形|增肌|马甲线|腹肌|薄肌身材|更上镜)/);
  if (goal) result.goal = goal[1];

  if (/(?:不运动|没(?:有)?运动|基本不动)/.test(text)) {
    result.exercise = '目前不运动';
  } else {
    const exercise = text.match(/(?:每周|一周)[^，,。！？\n]{0,20}(?:跑步|健身|力量训练|打球|攀岩|游泳|骑车|瑜伽|普拉提)[^，,。！？\n]{0,20}/);
    if (exercise) result.exercise = exercise[0].trim();
  }

  const taste = text.match(/(?:喜欢吃?|爱吃|偏爱|偏好)([^，,。！？\n]{1,24})/);
  if (taste) result.taste = `喜欢${taste[1].trim()}`;

  return result;
}

function formatKnownSlots(slots) {
  const known = TRACKED_SLOT_KEYS.filter((key) => slots[key] && slots[key].value).map((key) => {
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

  // 饮食采集问题目前没有向用户展示“1/2”编号选项。孤立数字只有在上一轮
  // 明确询问预算时才有可靠含义；其余场景不能擅自把“1”猜成食堂、自选、
  // 某种口味等，否则同一个数字会随节点变化悄悄改写档案。
  if (BARE_NUMBER_REGEX.test(userText.trim()) && state.lastAskedSlot !== 'budget') {
    return { candidateSlots: {}, candidateConfirmationReasons: {}, skipCandidateFieldsOnce: [] };
  }

  const currentFocusLabel = state.lastAskedSlot
    ? SLOT_LABELS[state.lastAskedSlot]
    : '（上一轮没有主动问具体的哪一项）';

  const prompt = [
    {
      role: 'system',
      content:
        '你是一个信息抽取助手，任务是从用户这一轮说的话里，判断六项核心饮食信息' +
        '（就餐场景、口味偏好、预算、忌口/过敏、身材目标、是否运动），以及食堂' +
        '场景下额外的打饭方式里，哪些在这一轮有新信息。只抽取"这一轮用户实际' +
        '提供了什么"，不要替用户编造，' +
        '也不要把已经确认过的旧信息重复填一遍（除非用户这一轮明确又提了一次）。\n\n' +
        `目前已经掌握的信息：\n${formatKnownSlots(state.slots)}\n\n` +
        `上一轮AI主动问的是：${currentFocusLabel}——如果这一轮用户的回答很简短` +
        '或者有歧义（比如只回一个数字、一个词），优先结合"上一轮问的是什么"来' +
        '判断这句话对应六项里的哪一项，不要机械地要求逐字匹配。\n\n' +
        '特别注意"口味偏好"和"忌口/过敏"这两项：这两项存的都不能是孤立的关键词，' +
        '必须是能自我说明极性的完整说法。即使用户提到的是同一个词（比如"辣"），' +
        '在口味偏好里要存成"喜欢辣"这种表达喜欢的说法，在忌口里要存成"不吃辣"' +
        '这种表达要避开的说法——不能两边都简化成同一个"辣"字，否则后续没法' +
        '分辨到底是哪一种，等同于把两件相反的事记成了一样的。"是否运动"这一项' +
        '同理，要保留否定词，不能把"不运动"简化丢字变成"运动"。\n\n' +
        '再次强调最基本的底线：这一轮用户的消息可能信息量很少甚至完全没有' +
        '实质信息（比如只是一个孤立的词、一句寒暄），这种情况下六项里' +
        '大部分甚至全部都应该填 null——宁可多个字段都是 null，也不能因为' +
        '"想尽量给出完整的判断"就替用户编造内容。判断某一项该不该填之前，' +
        '先问自己："用户这句话里，真的包含这项信息吗？"而不是"这项信息' +
        '大概率会是什么？"。只有真的能在用户这句话里找到依据时才填，找不到' +
        '依据就必须填 null，不能因为上下文"看起来"该有某项信息就自己补上。\n\n' +
        '下面这两个例子请特别注意，这是实测中真实出现过的错误案例：\n' +
        '例1——上一轮正在问食堂打饭方式，用户说"自选"：cafeteriaMode 应填' +
        '"自己挑菜"，scene 和其余六项都填 null。\n' +
        '例2——用户主动说"我们食堂是固定套餐"：scene 填"食堂"，' +
        'cafeteriaMode 填"固定套餐"，不能把"固定套餐"错塞进预算或口味。\n' +
        '这两个例子共同说明：食堂打饭方式现在有独立字段，要正确保存，但仍然' +
        '不能把它误当成食堂/外卖这个场景字段本身。\n\n' +
        '还有一类同样真实出现过的错误，务必避开，但要注意这条规则的适用范围' +
        '很窄，不要过度套用：如果用户的回答，逐字就是某一项字段自己的类别' +
        '名称本身——具体只包括这几种情况：问忌口，用户就回"忌口"这两个字；' +
        '问预算，用户就回"预算"这两个字；问身材目标，用户就回"身材目标"或者' +
        '"目标"这几个字。只有这种逐字复述字段名称、没有任何具体内容的情况，' +
        '才需要填 null（错误示范：{"restrictions":"忌口"}、{"budget":"预算"}、' +
        '{"goal":"身材目标"}——这些都是把字段自己的名字当成了值）。\n' +
        '这条规则绝对不能扩大理解为"简短的回答都要谨慎"或者"跟AI提问里举的' +
        '例子长得像就要谨慎"——只要用户给出的是具体、有实质内容的答案，哪怕' +
        '很短，也必须正常抽取，不能因为担心"字段名回声"这个问题，就连真实' +
        '有效的答案也一起误伤填成 null。下面这些都是必须正常抽取、绝不能' +
        '填 null 的例子：用户回"穿衣更好看"，goal 必须填"穿衣更好看"（这是' +
        '具体的结果导向表述，不是在复述"身材目标"这个字段名称本身）；用户回' +
        '"20元左右"，budget 必须填"20元左右"；用户回"不吃香菜"，restrictions' +
        '必须填"不吃香菜"；用户回"不运动"，exercise 必须填"不运动"。这些例子' +
        '都包含具体、可执行的实质内容，跟单纯复述字段名称是完全不同的两回事。',
    },
    { role: 'human', content: userText },
  ];

  let extracted = await structuredModel.invoke(prompt);
  extracted = applyDeterministicExplicitCandidates(extracted, userText);
  extracted.scene = normalizeSceneFromContext({
    userText,
    lastAskedSlot: state.lastAskedSlot,
    extractedValue: extracted.scene,
  });
  extracted.restrictions = normalizeRestrictionFromContext({
    userText,
    lastAskedSlot: state.lastAskedSlot,
    extractedValue: extracted.restrictions,
  });
  extracted.goal = normalizeGoalFromContext({
    userText,
    lastAskedSlot: state.lastAskedSlot,
    extractedValue: extracted.goal,
  });
  extracted.exercise = normalizeExerciseFromContext({
    userText,
    lastAskedSlot: state.lastAskedSlot,
    extractedValue: extracted.exercise,
  });
  const normalizedTaste = normalizeTasteFromContext({
    userText,
    lastAskedSlot: state.lastAskedSlot,
    extractedValue: extracted.taste,
  });
  extracted.taste = normalizedTaste.value;

  const candidateSlots = {};
  const candidateConfirmationReasons = {};
  TRACKED_SLOT_KEYS.forEach((key) => {
    if (!extracted[key]) return;
    if ((state.skipCandidateFieldsOnce || []).includes(key)) return;
    if (isBareLabelEcho(key, extracted[key])) {
      if (process.env.LANGGRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[extractSlots] 丢弃了字段名回声候选值: ${key}=${extracted[key]}`);
      }
      return;
    }
    if (isUnsupportedBareNumberBudgetGuess(key, userText, state.lastAskedSlot)) {
      if (process.env.LANGGRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[extractSlots] 丢弃了零上下文孤立数字硬猜出的候选值: ${key}=${extracted[key]}`);
      }
      return;
    }
    if (isUnsupportedSceneGuess(key, extracted[key], userText, state.lastAskedSlot)) {
      if (process.env.LANGGRAPH_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[extractSlots] 丢弃了用户原话没有场景证据的候选值: ${key}=${extracted[key]}`);
      }
      return;
    }
    candidateSlots[key] = extracted[key];
    if (key === 'taste' && normalizedTaste.reason) {
      candidateConfirmationReasons[key] = normalizedTaste.reason;
    }
  });

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[extractSlots] 用户消息:', userText);
    // eslint-disable-next-line no-console
    console.log('[extractSlots] 抽取到的候选值:', JSON.stringify(candidateSlots));
  }

  const repeatedInfoApology = /我都说了|已经说了|说过了/.test(userText) &&
    candidateSlots.exercise === '目前没有运动'
    ? [{
        role: 'ai',
        content: '哦哦，不好意思，是我走神了，下次注意。已经记下你目前没有运动，我们继续哈。',
      }]
    : [];

  return {
    messages: repeatedInfoApology,
    candidateSlots,
    candidateConfirmationReasons,
    skipCandidateFieldsOnce: [],
  };
}

module.exports = {
  extractSlots,
  extractionSchema,
  normalizeRestrictionFromContext,
  normalizeGoalFromContext,
  normalizeTasteFromContext,
  normalizeExerciseFromContext,
  isUnsupportedSceneGuess,
  applyDeterministicExplicitCandidates,
  normalizeSceneFromContext,
  hasPositiveSceneEvidence,
};

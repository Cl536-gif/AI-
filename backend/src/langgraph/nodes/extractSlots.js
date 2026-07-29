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
      '这一轮用户消息里新提供的"就餐场景"信息，只能是"食堂"或"外卖"这两个类别' +
        '本身、或者明确的同义表达（比如"食堂打饭""叫外卖""点外卖"）。\n' +
        '特别注意：像"自选""固定套餐""自己选菜"这类词，说的是食堂内部具体的' +
        '"打饭/选菜方式"，属于另一个更细的信息层面，不是在说"食堂"还是"外卖"' +
        '这个场景本身——这两类信息性质不同，"自选"这类词不能被当成对场景的' +
        '重新表述或修正。遇到这类词时，这一项应该填 null，不要因为它出现在' +
        '"食堂/外卖"相关的对话语境里，就强行往"食堂"或"外卖"上关联。\n' +
        '如果这一轮消息完全没涉及场景信息，同样填 null，不要凭空猜测或沿用' +
        '旧值。'
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

const structuredModel = model.withStructuredOutput(extractionSchema, {
  name: 'extract_slots',
});

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

function isUnsupportedBareNumberBudgetGuess(key, userText, lastAskedSlot) {
  if (key !== 'budget') return false;
  if (lastAskedSlot === 'budget') return false; // 上一轮就是在问预算，这是合理语境
  return BARE_NUMBER_REGEX.test(userText.trim());
}

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
        '例1——用户说"自选"：这个词说的是食堂内部具体的打饭/选菜方式（比如' +
        '"自己选菜"vs"固定套餐"），不属于就餐场景（食堂/外卖），也不天然' +
        '属于口味、预算、忌口、身材目标、是否运动里的任何一项。正确输出应该是' +
        '六项全部为 null：{"scene":null,"taste":null,"budget":null,' +
        '"restrictions":null,"goal":null,"exercise":null}。错误做法是把' +
        '"自选"这个词原样塞进 scene 字段（这是错的，"自选"不是"食堂"或' +
        '"外卖"，不能直接把用户说的词照抄进某个字段，字段里填的必须是这六项' +
        '各自要求的具体内容，不是随便找个看起来相关的字段就把原词塞进去）。\n' +
        '例2——用户说"固定套餐"：同理，这也是食堂内部的选菜方式，不是预算，' +
        '不能因为它出现在跟吃饭相关的对话里就归到预算或其他任何一项，正确输出' +
        '同样是六项全部为 null。\n' +
        '这两个例子共同说明的原则：判断一个词该填进哪个字段，不能只看它是否' +
        '"和吃饭沾边"，必须先确认这个词说的确实是六项定义里的那件事本身，' +
        '确认不了就必须是 null，绝不能把原词照抄进某个凑巧相关的字段。\n\n' +
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

  const extracted = await structuredModel.invoke(prompt);

  const candidateSlots = {};
  SLOT_KEYS.forEach((key) => {
    if (!extracted[key]) return;
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
    candidateSlots[key] = extracted[key];
  });

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[extractSlots] 用户消息:', userText);
    // eslint-disable-next-line no-console
    console.log('[extractSlots] 抽取到的候选值:', JSON.stringify(candidateSlots));
  }

  return { candidateSlots };
}

module.exports = { extractSlots, extractionSchema };

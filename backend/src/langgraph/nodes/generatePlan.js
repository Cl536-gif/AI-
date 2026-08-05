// 出方案节点：checkCompleteness 判定六项信息全部确认完毕后，走到这里。
// 检索复用 localKbBridge.retrieveFromKbs（跟 /api/chat-local 用的是
// 同一份检索逻辑，不重写），提示词完整复用 systemPrompt.js，格式
// 兜底接入 formatGuard.js——三样都不重新发明，跟 askNextQuestion
// 是同一套做法。
const config = require('../../config');
const { model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { generateWithFormatGuard } = require('../../services/formatGuard');
const localKbBridge = require('../../services/localKbBridge');
const { SLOT_KEYS, SLOT_LABELS } = require('../state');
const { getMessageRole, getMessageText } = require('../utils/messages');

const TOP_K_PER_KB = 5;

function formatConfirmedSlots(slots) {
  return SLOT_KEYS.map((key) => `${SLOT_LABELS[key]}: ${slots[key].value}`).join('\n');
}

// 拿六项已确认的值拼成检索query，检索跟这个具体用户画像相关的知识库
// 片段（跟 localChatService.js 用当前这句话去检索是同一个思路，只是
// 这里没有"当前这句话"，用六项信息本身代替）。
function buildRetrievalQuery(slots) {
  return SLOT_KEYS.map((key) => slots[key].value).filter(Boolean).join(' ');
}

function formatKnowledgeSections(perKb) {
  return perKb
    .filter((kb) => kb.results.length > 0)
    .map((kb) => {
      const chunks = kb.results
        .slice(0, TOP_K_PER_KB)
        .map((r, i) => `(${i + 1}) ${r.text}`)
        .join('\n');
      return `【知识库: ${kb.kbName}】\n${chunks}`;
    });
}

// pendingServiceAck已经用固定模板呼应过订阅时间，但真实测试发现LLM
// 有时候还是会不听指令、自己在方案开头又写一遍意思重复的呼应句（措辞
// 不完全一样，比如"收到"/"已经帮你设置好"/"已为你设置"，formatGuard
// 检测不到这种"语义重复"）。这里不依赖猜测LLM具体会用哪种措辞，用一个
// 通用信号兜底：固定模板和LLM重复呼应的那句话，开头第一句里必然都会
// 出现用户设定的推送时间原文（pushSchedule）——只要生成内容的第一句
// 里出现了这段原文，就说明大概率是在重复呼应订阅这件事，直接把这一句
// 删掉。删除后紧跟着的通常是"复述六项信息"这句话（taskInstruction
// 本来就要求方案以这句开头），本身就是能独立成句的开场白（免费模式下
// 方案也是这样直接开头的，见真实测试），不需要额外拼接过渡词。
function stripDuplicateScheduleAck(text, pushSchedule) {
  if (!pushSchedule) return text;
  const firstBreakIndex = text.search(/[。！～\n]/);
  const firstSegment = firstBreakIndex === -1 ? text : text.slice(0, firstBreakIndex + 1);
  if (!firstSegment.includes(pushSchedule)) return text;
  return text.slice(firstSegment.length).replace(/^[\s\n]+/, '');
}

// 指令层面明确要求过"完全不能提推送/提醒这个话题"，真实测试发现LLM
// 还是屡教不改地在剥离掉重复呼应句后，紧接着单独写一行括号补充说明
// （比如"悄悄说：这个提醒是XX""这个提醒会从明天开始生效"），措辞每次
// 都不一样、内容还经常跟固定模板自相矛盾。不再猜测具体措辞，改成认
// 结构特征：这句话固定是紧跟在开头、独立成行、被括号整个包住——只要
// 剥离完重复呼应句之后，紧接着的还是这种"整行都在括号里"的结构，直接
// 整行删掉，不用管里面具体写了什么。
function stripLeadingParenthetical(text) {
  return text.replace(/^[（(][^）)]*[）)][ \t　]*\n*/, '');
}

// 真实测试撞见过更严重的一种失败：LLM在重试压力大时，最后一次生成
// 干脆不写方案正文，只留呼应语+一句无关括号说明——这两处一剥离，
// 剩下的方案内容就是空字符串，会把一句只有确认语的空洞回复发给
// 用户。这里加一道最后防线：剥离完毕后如果内容短到不像话，就不放行
// 这次结果，换成一句诚实的确定性兜底话，把"给方案"这件事留到下一轮，
// 总比把看起来答非所问的空话发给用户安全。
//
// MIN_PLAN_LENGTH=20 这个阈值是拿真实测试日志里的两组数据定的：失败
// 案例剥离后是0字；同一批日志里能找到的最短的真实完整方案（订阅+
// 免费两种场景各挑了一个）剥离/复述后都在260字以上——20只是这两个
// 数量级之间随便留出的安全余量（十几倍开外），不是卡着算出来的精确
// 边界，以后如果观察到有正常方案被误判成"缺失"，可以直接调高这个
// 数字，不用重新推导。
const MIN_PLAN_LENGTH = 20;
const NO_PLAN_FALLBACK_TEXT = '这顿的具体搭配我再想想，你先说说刚才这几项信息有没有需要补充的～';
const MEAL_TIMING_CLOSING =
  '这份搭配适合午餐或晚餐；如果想安排早餐，告诉我，我会另外给你早餐方案～';

function normalizeMealTimingClosing(text) {
  const withoutQuestion = String(text || '')
    .replace(
      /(?:这顿|这份(?:搭配|方案)?)[^。！？\n]{0,40}(?:中午|午餐)[^。！？\n]{0,30}(?:晚上|晚餐)[^。！？\n]*[？?][^。！？\n]*[。！？～~]?/g,
      ''
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (/适合(?:午餐|中餐)(?:或|和)(?:晚餐|晚饭)/.test(withoutQuestion) && /早餐/.test(withoutQuestion)) {
    return withoutQuestion;
  }
  return `${withoutQuestion}\n\n${MEAL_TIMING_CLOSING}`.trim();
}
const BODY_ONBOARDING_QUESTION =
  '接下来再了解几项基础信息，我会用来帮你把饮食安排得更贴合：\n\n' +
  '1. 年龄，例如22岁\n' +
  '2. 身高，例如165厘米\n' +
  '3. 当前体重，例如55公斤或110斤\n' +
  '4. 平时活动情况，例如久坐、走动较多\n\n' +
  '如果你想跟我说，也可以加上目标体重和最近一个月的体重变化。' +
  '可以像“22岁、165厘米、55公斤、平时久坐”这样一次告诉我～';
const CYCLE_ONBOARDING_QUESTION =
  '接下来再了解一下经期情况，这会帮助我结合你的个人节奏安排饮食：\n\n' +
  '1. 周期大致规律还是不规律\n' +
  '2. 最近一次月经开始日期\n' +
  '3. 如果记得，前两次大概什么时候开始\n' +
  '4. 经期前后是否容易饿、疲劳、腹胀或疼痛\n\n' +
  '有月经的话，按你记得的告诉我就好；没有月经或暂时不方便提供，也直接跟我说。' +
  '后面我会结合你的周期和实际状态，适当调整饮食，帮助你应对容易饿、疲劳或腹胀这些变化。';

async function generatePlan(state) {
  const query = buildRetrievalQuery(state.slots);
  const perKb = await localKbBridge.retrieveFromKbs(query, config.localKbNames);
  const knowledgeSections = formatKnowledgeSections(perKb);
  const cafeteriaModeInstruction = state.slots.cafeteriaMode?.confirmed
    ? `食堂打饭方式（后台信息，不要放进六项复述）：${state.slots.cafeteriaMode.value}。` +
      (state.slots.cafeteriaMode.value === '自己挑菜'
        ? '方案要直接帮助用户搭配主食、菜和生活化分量，并给出窗口选菜时的实际做法。\n\n'
        : '方案要以窗口已经配好的整份套餐为前提，重点说明拿到套餐后怎么取舍、吃多少和如何替换，不能假设用户可以自由组合每一道菜。\n\n')
    : '';
  const serviceClosingInstruction =
    state.serviceTier === 'subscribed'
      ? '这版方案的结尾要明确告诉用户：先按这版试试看，不用一下子改得太多；' +
        '之后秘书会结合长期记录分阶段调整，陪用户一步一步找到更适合自己的吃法。' +
        '不要把这层意思简化成“分量不够可以自己调整”。\n\n'
      : '这版方案的结尾要明确告诉用户：先按这版试试看，不用一下子改得太多；' +
        '如果吃完仍然觉得饿，晚一点可以适当加一点，不用硬扛，有问题可以再来问。' +
        '不能承诺按时间持续跟进、主动调整或分阶段规划。不要把这层意思简化成' +
        '“分量不够可以自己调整”。\n\n';

  const taskInstruction =
    (state.pendingServiceAck
      ? '【最优先规则，必须严格遵守，排在下面所有要求之前】用户上一句刚' +
        '说完推送提醒的时间偏好，这件事已经用一句固定话术单独回复过了，' +
        '不需要你处理，也不了解你不掌握的推送系统细节（比如具体什么时候' +
        '生效、要不要用户再手动开启之类）。你接下来要写的内容里，完全不能' +
        '出现任何形式、任何位置（包括括号里的补充说明、"悄悄说"这类小声' +
        '提示）跟推送/提醒这件事沾边的话——不能呼应确认（"收到""已经帮你' +
        '设置好""已为你设置"），不能提到具体时间点，也不能评论这个功能' +
        '什么时候生效、要满足什么条件才生效。就当这个话题完全不存在，' +
        '直接从下面"先用一句话复述已收集到的信息"开始写。\n\n'
      : '') +
    '【本轮任务】六项信息已经全部确认完毕，现在请按第2条要求先用一句话' +
    '复述已收集到的信息，再给出第一版具体的饮食方案（只给"这一顿/今天"' +
    '这一次的方案，不要甩出多日框架）。\n\n' +
    '已经确认的信息：\n' +
    `${formatConfirmedSlots(state.slots)}\n\n` +
    cafeteriaModeInstruction +
    serviceClosingInstruction +
    (knowledgeSections.length > 0
      ? `可参考的知识库资料：\n${knowledgeSections.join('\n\n')}\n\n` +
        '资料里的对话示例、话术模板只是参考语气用的，不能原样搬进回复里，' +
        '也不能直接把资料内容当成必须照搬的方案标准，涉及科普说明时依然' +
        '要遵守第12条学术引用铁律。\n\n'
      : '（本地知识库这次没有检索到直接对应的资料，不能假装有资料支撑——这一版' +
        '方案里要用自然口语化的说法，顺带如实告诉用户这一点，语气可以类似' +
        '"这块我目前没查到专门的资料，先凭经验给你个方向"这种程度（这只是' +
        '示范语气，不是让你原样照抄这句话），说完这句依然要正常往下给出具体、' +
        '可执行的饮食方案，不能因为没有资料支撑就回避给方案、或者把责任推给' +
        '用户重新提问，更不能说"建议咨询专业营养师""请换个问法"这类生硬的' +
        '客服话术。）\n\n') +
    '六项信息该收集到哪一步、要不要出方案，已经由外部状态决定好了（已经' +
    '确认全部收集完毕），你不需要自己判断采集进度，只需要结合上面完整的' +
    '系统规则给出第一版具体方案——尤其注意第9条（默认推荐大众化菜品，' +
    '不要健身向/小众菜品）、第17/23条（分量用"一拳米饭""一掌蔬菜"这类' +
    '生活化类比，禁止精确克数）、第43条（食堂场景下每道菜都要主动带一句' +
    '"如果食堂没有，换成XX"的替代方案，不能默认用户能自己控制烹饪方式）、' +
    '第41条（举例按类别就够，不用过度细化到具体口味/品类）。另外，不能把' +
    '“一掌大小”直接换算成固定几片或几块，不同窗口切片大小不同；也不能仅凭' +
    '菜名声称替代菜与原菜热量、营养结构相同或接近，不同食堂的用油、糖、配方' +
    '和分量都可能不同。小炒肉、肉丝、鸡丁等大小不固定的混合炒菜，也不能说' +
    '“只吃三四片/几块就够了”，要使用一种生活化的整体分量描述。方案结尾不要' +
    '再问用户安排午餐还是晚餐，直接说明“这份搭配适合午餐或晚餐；如果想安排早餐，告诉我，我会另外给早餐方案”，' +
    '因为早餐的食物结构和分量需要单独安排。';

  const userMessages = state.messages
    .filter((m) => getMessageRole(m) === 'human')
    .map((m) => getMessageText(m));

  const { text: rawReplyText } = await generateWithFormatGuard({
    userMessages,
    generate: async (retryInstruction) => {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: taskInstruction },
        ...(retryInstruction ? [{ role: 'system', content: `【重新生成要求】${retryInstruction}` }] : []),
        ...state.messages,
      ];
      const response = await model.invoke(messages);
      return response.content;
    },
  });

  // 指令层面已经要求LLM不要重复呼应订阅时间、也不要评论推送机制，但
  // 真实测试发现它偶尔还是会不听——这里再做两层确定性兜底，具体逻辑
  // 见 stripDuplicateScheduleAck / stripLeadingParenthetical 的注释。
  const strippedReplyText = state.pendingServiceAck
    ? stripLeadingParenthetical(stripDuplicateScheduleAck(rawReplyText, state.pushSchedule))
    : rawReplyText;

  // 不管走免费还是订阅分支，剥离完呼应/括号说明之后再统一做一次内容
  // 完整性兜底，具体逻辑和阈值依据见 MIN_PLAN_LENGTH 的注释。
  const isPlanMissing = strippedReplyText.trim().length < MIN_PLAN_LENGTH;
  const replyText = isPlanMissing
    ? NO_PLAN_FALLBACK_TEXT
    : normalizeMealTimingClosing(strippedReplyText);

  if (process.env.LANGGRAPH_DEBUG && isPlanMissing) {
    // eslint-disable-next-line no-console
    console.log(
      `[generatePlan] 剥离完呼应/括号说明后，方案内容只剩${strippedReplyText.trim().length}字（不足${MIN_PLAN_LENGTH}字阈值），` +
        '判定为内容缺失，改用确定性兜底话术。剥离后的原始内容:',
      JSON.stringify(strippedReplyText)
    );
  }

  // pendingServiceAck非空时，把这句确定性模板拼在LLM生成内容最前面——
  // 这句话本身不经过LLM、也不需要走formatGuard检测（纯字符串模板，
  // 不含加粗/列表/emoji/排比句这些违规的可能）。
  const finalText = state.pendingServiceAck ? `${state.pendingServiceAck}\n\n${replyText}` : replyText;
  const shouldAskBodyOnboarding =
    state.serviceTier === 'subscribed' && state.bodyOnboardingStatus === null;

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[generatePlan] 检索query:', query);
    // eslint-disable-next-line no-console
    console.log(
      '[generatePlan] 实际检索到并塞进prompt的资料片段:',
      knowledgeSections.length > 0 ? `\n${knowledgeSections.join('\n\n')}` : '（空，本轮理应触发"没查到资料"的兜底说法）'
    );
    // eslint-disable-next-line no-console
    console.log('[generatePlan] 生成的方案:', finalText);
  }

  return {
    messages: [
      { role: 'ai', content: finalText },
      ...(shouldAskBodyOnboarding ? [{ role: 'ai', content: BODY_ONBOARDING_QUESTION }] : []),
    ],
    retrieved: perKb,
    initialPlanDelivered: true,
    // 不管这一轮有没有用上pendingServiceAck，都要显式重置回null——
    // generatePlan六项确认完之后每一轮都会再次被路由到（同一个serviceTier
    // 会一直复用），不重置的话下一轮会被误判成"又刚设定了一次"，重复
    // 拼接这句话。
    pendingServiceAck: null,
    ...(shouldAskBodyOnboarding
      ? {
          bodyOnboardingStatus: 'asked',
          pendingBodyOnboarding: { askedCount: 1 },
        }
      : {}),
  };
}

module.exports = {
  generatePlan,
  BODY_ONBOARDING_QUESTION,
  CYCLE_ONBOARDING_QUESTION,
  MEAL_TIMING_CLOSING,
  normalizeMealTimingClosing,
};

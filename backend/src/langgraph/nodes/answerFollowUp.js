const { model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { findLastUserMessage, getMessageText } = require('../utils/messages');

const SIMPLE_ACK_REGEX = /^(?:好|好的|好呀|可以|行|知道了|明白了|收到|谢谢|谢谢你|ok|okay)[。！!～~]?$/i;
const TEMPORARY_FOOD_CRAVING_REGEX = /(?:现在|今天|这顿|待会儿|一会儿)?[^。！？]{0,12}(?:想吃|馋|想来(?:一份|一个|点)?)/;
const SECOND_MESSAGE_SEPARATOR = '<<<SECOND_MESSAGE>>>';
const REGISTRATION_MEMORY_QUESTION_REGEX =
  /(?=.*(?:注册|登录|账号))(?=.*(?:记得|记住|保存|存档))(?=.*(?:上一顿|之前|以前|吃了什么))/;
const EXECUTION_STATUS_QUESTION_REGEX =
  /(?:什么|啥|怎么理解|指的?是).{0,8}(?:执行情况|执行得怎么样)|(?:执行情况|执行得怎么样).{0,8}(?:什么|啥|怎么理解|指的?是)/;
const REPEATED_LONG_TERM_GOAL_REGEX =
  /(?=.*(?:女大学生|女生|女性))(?=.*(?:想|要|目标|希望))(?=.*(?:减脂|减肥|塑形|瘦|上镜|马甲线|薄肌))/;

const MAX_CONTEXT_CHARS = 4000;
const MAX_RECENT_EVENTS = 5;
const MAX_MEAL_GUIDANCE_ITEMS = 4;

function compactText(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function compactProfile(profileRecord) {
  const profile = profileRecord?.profile;
  if (!profile) return null;
  const body = profile.body || {};
  const diet = profile.diet || {};
  return {
    body: {
      equationSex: body.equationSex ?? null,
      ageYears: body.ageYears ?? null,
      heightCm: body.heightCm ?? null,
      currentWeightKg: body.currentWeightKg ?? null,
      targetWeightKg: body.targetWeightKg ?? null,
      dailyActivity: compactText(body.dailyActivity, 120),
      recentWeightChange: compactText(body.recentWeightChange, 120),
    },
    diet: {
      scene: diet.scene || 'unknown',
      cafeteriaMode: diet.cafeteriaMode || 'unknown',
      budgetCnyPerMeal: diet.budgetCnyPerMeal ?? null,
      tastePreferences: (diet.tastePreferences || []).slice(0, 12).map((item) => compactText(item, 80)),
      restrictions: (diet.restrictions || []).slice(0, 12).map((item) => compactText(item, 100)),
      goals: (diet.goals || []).slice(0, 8).map((item) => compactText(item, 120)),
      exerciseBaseline: compactText(diet.exerciseBaseline, 160),
    },
  };
}

function compactPlan(activePlan) {
  const plan = activePlan?.plan;
  if (!plan) return null;
  return {
    stageLabel: compactText(plan.stageLabel, 100),
    objective: compactText(plan.objective, 300),
    durationDays: plan.durationDays,
    mealGuidance: (plan.mealGuidance || []).slice(0, MAX_MEAL_GUIDANCE_ITEMS).map((item) => ({
      mealType: item.mealType,
      guidance: compactText(item.guidance, 500),
    })),
    adjustmentRules: (plan.adjustmentRules || []).slice(0, 6).map((item) => compactText(item, 240)),
  };
}

function compactEnergy(calculation) {
  if (!calculation) return null;
  return {
    estimatedBmrKcalPerDay: calculation.outputs?.estimatedBmrKcalPerDay ?? null,
    estimatedTeeKcalPerDay: calculation.outputs?.estimatedTeeKcalPerDay ?? null,
    calculatedAt: calculation.createdAt || null,
  };
}

function compactEvents(events) {
  return (events || []).slice(0, MAX_RECENT_EVENTS).map((event) => ({
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    summary: compactText(event.payload?.summary, 240),
  }));
}

function compactAdvice(items) {
  return (items || []).slice(0, 5).map((item) => ({
    adviceType: item.adviceType,
    serviceMode: item.serviceMode,
    content: compactText(item.content, 900),
    createdAt: item.createdAt,
  }));
}

function buildFollowUpContextMessage(longTermContext) {
  if (!longTermContext) return null;

  const hasLongTermAccess = longTermContext.accessMode === 'long_term';

  const compactContext = {
    serviceStatus: longTermContext.serviceStatus || 'free',
    temporalContext: longTermContext.temporalContext || null,
    profile: compactProfile(longTermContext.profile),
    activePlan: hasLongTermAccess ? compactPlan(longTermContext.activePlan) : null,
    pausedPlan: hasLongTermAccess ? compactPlan(longTermContext.pausedPlan) : null,
    energyEstimate: hasLongTermAccess ? compactEnergy(longTermContext.latestEnergyCalculation) : null,
    recentEvents: hasLongTermAccess ? compactEvents(longTermContext.recentEvents) : [],
    recentAdvice: compactAdvice(longTermContext.recentAdvice),
    developerTestPersona: longTermContext.developerTestPersona || null,
    timeline: hasLongTermAccess ? longTermContext.timeline : null,
  };
  const serialized = JSON.stringify(compactContext).slice(0, MAX_CONTEXT_CHARS);
  return {
    role: 'system',
    content:
      '以下是业务层按当前权限提供的用户上下文摘要，仅在与用户本轮问题直接相关时使用：\n' +
      serialized + '\n' +
      '这是已经建立过档案的用户：不要再次发送首次自我介绍，不要重新询问摘要中已有的基础资料。' +
      '回答要求：先直接回答本轮问题；不要主动复述整份档案、计算过程或内部字段；' +
      '如果引用摘要里的历史档案，必须明确说“之前的档案里记录过”，禁止说成“你刚才提到”或冒充本轮用户原话；' +
      '不要声称摘要中没有的事实；近期事件按新到旧排列；除非用户明确询问，否则不要主动提及经期或具体热量数字；' +
      '长期用户已经知道秘书会记住资料。给出餐食或阶段方案时直接说安排，不要重复解释“结合你的预算、食堂模式、目标和档案来搭配”，' +
      '也不要为了证明记忆而复述睡眠、饥饿、力气等已知情况；只有该信息直接影响本轮安全判断时才简短提及。' +
      'activePlan存在时，不得说“这周没有规划”或“尚未建立计划”；应直接概括当前阶段目标。' +
      '如果活动方案采用阶段框架而非每天固定菜单，可以自然说“这周按当前阶段的方向走，不用每天卡死菜单”。' +
      '涉及今天、明天、昨天、当前时间或星期时，只能使用temporalContext里的当地日期、星期和时区；' +
      '禁止根据档案更新时间、事件时间、聊天内容或模型记忆自行推断日期和星期；temporalContext缺失时不得给出具体星期或当前时间；' +
      '涉及当前这一餐时，用户明确说出的早餐、午餐、晚餐或加餐优先使用explicitMealTarget；用户没有明确餐次时，才可参考mealTiming；' +
      '“晚上容易饿”“早上没精神”等身体感受不等于用户指定了晚餐或早餐，不得据此擅自改餐次；' +
      '不得对用户说“按档案里记录的最新时间推断”。timeline由业务层按用户当前时区计算，planDay表示长期方案第几天，绝不能自行猜测或改写。' +
      'dueCheckIn为day_2_meal_feedback时，只询问昨天方案的饱腹感、饥饿时间、肠胃反应、菜品可得性和分量是否合适，不问体重；' +
      'dueCheckIn为weekly_review时，简洁询问本周饱腹感、精神状态、执行难点，并邀请用户在同一时间和同一台秤下提供本周体重。' +
      '不得因一周体重未下降就断言进入平台期；判断趋势前需结合连续数周体重、饮食执行、活动、睡眠及经期水分变化。' +
      'recentAdvice是秘书此前真实发送并保存的饮食建议历史，不代表用户已经照着吃过。' +
      '长期方案存在energyEstimate时，方案的饮食结构和分量是结合后台能量估算安排的；' +
      '不得说成“不会跟踪卡路里”或“方案没有计算热量”。应自然说明：方案本身已经按估算需求安排，' +
      '但秘书无法自动知道用户在方案之外实际吃了什么；额外零食、加餐、饮料或分量变化需要用户主动告诉秘书，才能计入当天记录并据此调整。' +
      '不要声称能在用户未告知时自动观察、识别或精确统计实际摄入。' +
      '如果用户询问“之前的饮食规划/方案”，recentAdvice非空时必须如实说明此前给过第一版或临时餐食建议并概括最近一条；' +
      '除非activePlan存在，否则不能把免费建议称为正式长期规划，但也绝不能说“从未给过具体餐单”。' +
      '如果recentAdvice为空，只能说“当前数据库没有保存到可读取的历史建议”，并说明旧版本可能生成过但当时未持久化；' +
      '不得把“数据库没有记录”推断成“秘书以前一定没有给过”。' +
      '以上是内部判断规则，绝不能把“数据库、可读取、为空、null、持久化、字段、记录数”等系统术语直接说给用户。' +
      '对用户要像熟悉她情况的真人饮食秘书一样自然表达，例如“之前给过的临时搭配没有完整存进这份档案里，目前还没开始长期规划哈”；' +
      '不要用括号汇报系统状态，也不要解释内部存储机制。' +
      (hasLongTermAccess
        ? ''
        : '当前没有长期计划读取权限，不得声称已经读取、更新或执行长期方案，也不得使用长期事件、计算或经期历史；') +
      '回答尽量简洁，只在确有必要时提出一个后续问题。\n' +
      '禁止用“吃完有感觉了告诉我”这种含糊表达；应明确说可以反馈分量够不够、多久又饿、是否不舒服或菜品是否买得到。' +
      '方案调整边界：单餐换菜、分量反馈、一次零食或一次运动，只针对当餐给出小幅建议，不要声称已经改写长期计划；' +
      '用户表示旅行、生病、连续多天无法执行或断联导致计划被打乱时，先处理当下情况，并询问之后是恢复原计划还是按新情况重做，' +
      '不要要求追补、挨饿或惩罚性减少饮食；目标、作息、就餐条件或活动水平出现持续性明显变化时，说明可能需要建立新阶段版本并先征求确认，' +
      '在用户确认且完整新方案正式给出前，不得声称新版已经建立或开始执行。' +
      '如果摘要中存在pausedPlan且没有activePlan：用户明确要继续原计划时，简短确认恢复；用户明确要重做时，先询问现在发生了哪些持续变化；' +
      '用户没有明确选择时，只问“继续原计划还是按现在的情况重新调整”，不得替用户决定。',
  };
}

async function answerFollowUp(state, { chatModel = model } = {}) {
  const userText = getMessageText(findLastUserMessage(state.messages)).trim();
  const hasLongTermAccess = state.longTermContext?.accessMode === 'long_term';
  if (hasLongTermAccess && EXECUTION_STATUS_QUESTION_REGEX.test(userText)) {
    return {
      messages: [{
        role: 'ai',
        content:
          '就是想了解这段时间按方案吃下来怎么样哈，比如：\n\n' +
          '1. 哪些搭配容易做到，哪些菜在食堂不太好找\n' +
          '2. 分量够不够，吃完多久会饿\n' +
          '3. 有没有额外吃零食、加餐，或者哪顿没按安排吃\n' +
          '4. 最近的睡眠、精神状态和活动情况\n' +
          '5. 有没有肠胃不舒服或其他身体变化\n\n' +
          '不用每项都回答，也不是检查你有没有严格照做。先告诉我最明显的一点，我再帮你把后面的安排调得更合适。',
      }],
    };
  }
  if (hasLongTermAccess &&
      REPEATED_LONG_TERM_GOAL_REGEX.test(userText) &&
      !/(?:不想|不要|改成|换成|目标变了|重新定)/.test(userText)) {
    const timeline = state.longTermContext?.timeline;
    const progressText = timeline?.weightTrend?.status === 'possible_plateau'
      ? '咱们现在正在做阶段复盘。最近几周体重变化暂时不明显，先不用着急，我会结合这段时间的饮食、活动、睡眠和身体状态，看看接下来要不要小幅调整。'
      : '咱们现在已经在长期方案里了，我会继续根据这段时间的饮食反馈和身体状态，帮你一步一步调整。';
    return {
      messages: [{
        role: 'ai',
        content:
          `知道啦，你的目标一直是减脂哈。${progressText}\n\n` +
          '你今天想先聊最近吃下来的情况，还是直接安排这一顿？',
      }],
    };
  }
  if (REGISTRATION_MEMORY_QUESTION_REGEX.test(userText)) {
    return {
      messages: [{
        role: 'ai',
        content: hasLongTermAccess
          ? '会记得你主动告诉我的饮食记录哈。你吃完后告诉我大概吃了什么和分量，我会存进长期档案，之后可以接着帮你回顾和调整。不过以前没有告诉我、或者当时没有保存下来的那一餐，登录后也不能自动补回来。'
          : '注册后，你的基础档案和已经保存的信息可以跟着账号保留下来哈。不过普通模式不会持续记录每一餐，也不会根据每天的变化主动调整方案。\n\n如果开启长期饮食规划，在完成建档并收到第一份正式方案后，14天免费试用才会开始。之后你主动告诉我每餐吃了什么和大概分量，我就能持续记录并做阶段调整。以前没有保存下来的那一餐，注册后也不能自动补回来。',
      }],
    };
  }
  if (SIMPLE_ACK_REGEX.test(userText)) {
    const timeline = state.longTermContext?.timeline;
    if (timeline?.dueCheckIn === 'day_2_meal_feedback') {
      return { messages: [{
        role: 'ai',
        content: '那我们先从昨天这顿说起哈：分量吃着够不够，吃完多久会饿，肠胃有没有不舒服？想到最明显的一点告诉我就行。',
      }] };
    }
    if (timeline?.dueCheckIn === 'weekly_review') {
      return { messages: [{
        role: 'ai',
        content: '那先说说这一周最明显的感受吧：分量、饥饿感、精神状态和执行难度里，哪一项最需要我帮你调整？\n\n今天方便的话，也可以在和上次差不多的时间、用同一台秤称一次，把体重告诉我。我会结合连续几周的变化看趋势，不会只凭一次数字下结论。',
      }] };
    }
    if (timeline?.weightTrend?.status === 'possible_plateau') {
      return { messages: [{
        role: 'ai',
        content: '那我们先从最近一周看起哈：饮食分量、额外零食、活动、睡眠和身体状态里，哪一项变化最明显？你先说最容易想到的一项就行。',
      }] };
    }
    const hasDeliveredPlan = Boolean(state.initialPlanDelivered || state.longTermContext?.activePlan);
    const suggestedMeal = state.longTermContext?.temporalContext?.mealTiming?.suggestedMeal;
    return {
      messages: [{
        role: 'ai',
        content: hasDeliveredPlan
          ? (suggestedMeal === 'dinner'
            ? '好，那先从今晚这顿开始哈。老样子，不爱吃、食堂没有或者分量不合适，告诉我就行。我们一步一步来，吃完再看要不要调整下一顿。'
            : '好，那先按这顿的安排吃哈。老样子，不爱吃、实际没有或者分量不合适，告诉我就行。我们一步一步来。')
          : '好，有新的饮食情况或具体问题时直接告诉我就可以哈。',
      }],
    };
  }

  const longTermContextMessage = buildFollowUpContextMessage(state.longTermContext);
  const isTemporaryFoodCraving = TEMPORARY_FOOD_CRAVING_REGEX.test(userText);
  const response = await chatModel.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content:
        '第一版方案和用户档案已经在前文确认过。本轮只回答用户刚提出的问题，或者只调整用户点名的饮食部分。' +
        '不要再次复述六项信息、年龄身高体重、经期记录或整份第一版方案；除非用户明确要求查看档案。',
    },
    ...(isTemporaryFoodCraving ? [{
      role: 'system',
      content:
        '用户只是临时说想吃某种食物，这不代表已经吃过，也不代表已经改变长期计划。' +
        '请输出两条简洁消息，并严格只用标记<<<SECOND_MESSAGE>>>分隔：' +
        '第一条直接告诉用户这顿想吃的食物怎样搭配、建议分量和需要留意的地方；' +
        '不要使用“按原计划继续”“原计划”“记录下来”等含糊说法。' +
        '第二条由秘书主动给出一个更清爽但口味相近、现实中容易买到的替代选择，不能反问用户要不要看其他选择，结尾也不要提问。',
    }] : []),
    ...(longTermContextMessage ? [longTermContextMessage] : []),
    ...state.messages,
  ]);
  const responseParts = isTemporaryFoodCraving
    ? String(response.content || '')
      .split(SECOND_MESSAGE_SEPARATOR)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 2)
    : [String(response.content || '').trim()].filter(Boolean);

  return { messages: responseParts.map((content) => ({ role: 'ai', content })) };
}

module.exports = {
  answerFollowUp,
  SIMPLE_ACK_REGEX,
  TEMPORARY_FOOD_CRAVING_REGEX,
  SECOND_MESSAGE_SEPARATOR,
  REGISTRATION_MEMORY_QUESTION_REGEX,
  EXECUTION_STATUS_QUESTION_REGEX,
  REPEATED_LONG_TERM_GOAL_REGEX,
  MAX_CONTEXT_CHARS,
  MAX_RECENT_EVENTS,
  buildFollowUpContextMessage,
};

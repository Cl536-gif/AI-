const bailianClient = require('./bailianClient');
const { getUserStore } = require('../stores/userStoreProvider');
const contentSafety = require('./contentSafety');

const INACTIVITY_THRESHOLD_DAYS = Number(process.env.INACTIVITY_THRESHOLD_DAYS) || 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const privacyOnboardingUsers = new Set();

const FIRST_VISIT_GREETING_MESSAGES = [
  '你好呀～我是你的饮食秘书，专门帮你把减脂变得更轻松、更生活化。',
  '为了给你更贴近日常、真正能吃到的建议，我会先问几个简单的饮食问题。了解完后，我会先给你一份符合平时饮食习惯的方案作为参考。',
  '你提供的全部信息，只会用于为你定制饮食建议和维护专属档案。以后如果需要新增其他用途，我会提前向你说明并征得你的同意。你也可以随时查看、修改或申请删除自己的档案。',
  '想查看《隐私政策》的重点条款，请回复“1”；已经了解并想开始，请回复“2”或“继续”。',
];

const PRIVACY_POLICY_SUMMARY = [
  '可以，我先把与你最相关的隐私规则说清楚：',
  '1. 收集范围：只收集提供饮食建议和维护个人档案所需要的信息。',
  '2. 使用目的：信息仅用于个性化饮食建议、档案更新和你主动选择的服务。新增其他用途前，会先说明并征得你的同意。',
  '3. 敏感信息：身体数据、经期等信息会单独说明用途，并按对应的授权范围使用。',
  '4. 你的权利：你可以提出查看、修改或删除个人档案，也可以撤回已经作出的授权。',
].join('\n');

const PRIVACY_FOLLOW_UP = '以上是最重要的几条。还有隐私问题可以直接问我；如果已经了解，回复“2”或“继续”，我们就开始。';
const PRIVACY_LATER_REMINDER = '好的，后续如果想查看，随时对我说“隐私政策”，我会把重点条款发给你。';
const FIRST_DIET_QUESTION = '好，那咱们先从日常吃饭聊起哈：你平时主要吃食堂还是点外卖？';

function classifyPrivacyOnboardingMessage(message) {
  const text = String(message || '').trim();
  if (/^1[。！!，, ]*$/.test(text)) return 'policy';
  if (/^2[。！!，, ]*$/.test(text)) return 'continue';
  if (/^(?:(?:没有(?:问题)?|没问题|没有了|没了|清楚了|明白了)[。！!，, ]*)?(?:继续|开始吧)[。！!，, ]*$/.test(text) ||
      /^(?:没有(?:问题)?|没问题|没有了|没了|清楚了|明白了|可以|好(?:的|吧)?|行|ok|okay)[。！!，, ]*$/i.test(text)) {
    return 'continue';
  }
  if (looksLikePrivacyRequest(text)) return 'policy';
  return 'pending';
}

function levenshteinDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  rows[0] = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
  }
  return rows[left.length][right.length];
}

function looksLikePrivacyRequest(text) {
  const compact = String(text || '').replace(/[\s，。！？!?、,.《》“”"']/g, '');
  if (/(?:隐私|条款|政策|个人信息|资料安全)/.test(compact)) return true;

  // 容纳“隐思政策”“隐私正策”一类单字错写，不要求用户背固定口令。
  const targets = ['隐私', '隐私政策', '隐私条款'];
  return targets.some((target) => {
    const minLength = Math.max(1, target.length - 1);
    const maxLength = target.length + 1;
    for (let length = minLength; length <= maxLength; length += 1) {
      for (let start = 0; start + length <= compact.length; start += 1) {
        if (levenshteinDistance(compact.slice(start, start + length), target) <= 1) return true;
      }
    }
    return false;
  });
}

function handlePrivacyOnboardingMessage(userId, message) {
  if (!privacyOnboardingUsers.has(userId)) return null;

  const action = classifyPrivacyOnboardingMessage(message);
  if (action === 'policy') {
    return { reply: PRIVACY_FOLLOW_UP, replies: [PRIVACY_POLICY_SUMMARY, PRIVACY_FOLLOW_UP], sessionId: null };
  }
  if (action === 'continue') {
    privacyOnboardingUsers.delete(userId);
    return {
      reply: FIRST_DIET_QUESTION,
      replies: [PRIVACY_LATER_REMINDER, FIRST_DIET_QUESTION],
      sessionId: null,
      nextRoute: 'langgraph',
    };
  }
  return {
    reply: '想查看隐私政策重点，请回复“1”；已经了解并想开始，请回复“2”或“继续”。',
    replies: ['想查看隐私政策重点，请回复“1”；已经了解并想开始，请回复“2”或“继续”。'],
    sessionId: null,
  };
}

function buildGreetingMessages(previousActiveAt, now = Date.now(), { longTermTimeline = null } = {}) {
  if (!previousActiveAt) return FIRST_VISIT_GREETING_MESSAGES;

  if (longTermTimeline?.planDay) {
    if (longTermTimeline.dueCheckIn === 'day_2_meal_feedback') {
      return [
        '早呀，今天我们继续一起调整哈。',
        '昨天第一版吃下来怎么样？分量够不够、吃完会不会很快饿，肠胃有没有不舒服？如果有哪道菜不好买或者不合口味，也告诉我，我从今天开始帮你调得更顺一些。',
      ];
    }
    if (longTermTimeline.dueCheckIn === 'weekly_review') {
      return [
        '到这周的小复盘时间啦，我们一起看看这一周吃得顺不顺哈。',
        '这周的分量合适吗？有没有经常饿、没精神或肠胃不舒服？哪几顿最难坚持？如果方便，也可以在同一时间、用同一台秤称一下体重告诉我。我会结合几周的变化趋势判断，不会因为一次数字波动就随便改方案。',
      ];
    }
    if (longTermTimeline.weightTrend?.status === 'possible_plateau') {
      return [
        '欢迎回来哈，这段时间你一直在认真记录，已经很不容易了。',
        '最近几周体重变化不明显，不代表之前的努力没有作用。我们先一起看看这段时间的饮食、活动、睡眠和身体状态，再决定要不要小幅调整，不需要靠少吃一顿来硬扛。',
      ];
    }
    return [
      '欢迎回来哈～',
      '今天吃饭、饥饿感、身体状态或者活动安排有变化，都可以直接告诉我，我会接着前面的记录帮你调整。',
    ];
  }

  const daysSinceLastActive = Math.floor(
    (now - new Date(previousActiveAt).getTime()) / MS_PER_DAY
  );
  if (daysSinceLastActive >= INACTIVITY_THRESHOLD_DAYS) {
    return [
      '宝子回来啦～',
      '这段时间吃饭或生活节奏有变化的话，直接告诉我哈，我们从现在的情况接着调整。',
    ];
  }
  return [
    '欢迎回来哈～',
    '有新的饮食情况或想问的问题，直接告诉我，我们接着聊。',
  ];
}

/**
 * 调用百炼获取回复，并做一层内容安全检查：
 * 检测到违规英文时先重新生成一次，仍不合规则做替换处理兜底。
 */
async function withSafetyCheck(callBailian) {
  let result = await callBailian();

  if (contentSafety.findEnglishViolations(result.reply).length === 0) {
    return result;
  }

  console.warn('[安全检查] 回复包含不允许的英文，触发重新生成');
  const retryResult = await callBailian();

  if (contentSafety.findEnglishViolations(retryResult.reply).length === 0) {
    return retryResult;
  }

  console.warn('[安全检查] 重新生成后仍包含英文，执行替换处理');
  return { ...retryResult, reply: contentSafety.sanitize(retryResult.reply) };
}

/** 页面打开时调用一次，让 AI 秘书结合"上次活跃时间"主动开场问候 */
async function getGreeting({
  userId,
  forceReturning = false,
  longTermTimeline = null,
  store = getUserStore(),
}) {
  const { previousActiveAt } = await store.recordActivity(userId);
  const effectivePreviousActiveAt = forceReturning
    ? (previousActiveAt || new Date().toISOString())
    : previousActiveAt;
  const replies = buildGreetingMessages(effectivePreviousActiveAt, Date.now(), { longTermTimeline });
  const privacyOnboardingPending = !effectivePreviousActiveAt;
  if (privacyOnboardingPending) privacyOnboardingUsers.add(userId);
  return {
    reply: replies[replies.length - 1],
    replies,
    sessionId: null,
    privacyOnboardingPending,
  };
}

/** 用户发送一条普通聊天消息 */
async function sendChatMessage({ userId, message, sessionId, store = getUserStore() }) {
  await store.recordActivity(userId);

  const privacyReply = handlePrivacyOnboardingMessage(userId, message);
  if (privacyReply) return privacyReply;

  return withSafetyCheck(() => bailianClient.sendMessage({ message, sessionId }));
}

module.exports = {
  getGreeting,
  sendChatMessage,
  buildGreetingMessages,
  classifyPrivacyOnboardingMessage,
  looksLikePrivacyRequest,
  handlePrivacyOnboardingMessage,
  FIRST_VISIT_GREETING_MESSAGES,
  PRIVACY_POLICY_SUMMARY,
  PRIVACY_FOLLOW_UP,
  PRIVACY_LATER_REMINDER,
  FIRST_DIET_QUESTION,
};

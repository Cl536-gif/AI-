const { findLastUserMessage, getMessageText, getMessageRole } = require('../utils/messages');
const { FIRST_TURN_INTRO } = require('./askNextQuestion');

const APPEARANCE_ANXIETY_REGEX = /(容貌焦虑|外貌焦虑|身材焦虑|照镜子[^。！？]*(难受|焦虑|崩溃)|觉得自己(?:太胖|很胖|不好看|很丑)|胖死了|丑死了)/;
const PERSISTENCE_DISTRESS_REGEX = /(坚持不下|不想坚持|快坚持不住|想放弃|做不到|没动力|好挫败|很挫败|减不下去|怎么都瘦不下)/;
const EATING_GUILT_REGEX = /(偷吃|吃多了|吃撑了|暴食|管不住嘴|没忍住)[^。！？]*(焦虑|后悔|内疚|自责|怎么办)?/;
const GENERAL_ANXIETY_REGEX = /(好焦虑|很焦虑|特别焦虑|压力好大|压力很大|心情不好|情绪不好|很崩溃|好崩溃)/;
const RETURNING_GREETING_REGEX = /(我回来[了啦咯]?|我又来[了啦咯]?|回来找你|又来找你)/;
const RETURNING_GREETING = '宝子回来啦～';

function classifyEmotionalContext(userText) {
  const text = String(userText || '').trim();
  if (APPEARANCE_ANXIETY_REGEX.test(text)) return 'appearance_anxiety';
  if (PERSISTENCE_DISTRESS_REGEX.test(text)) return 'persistence_distress';
  if (EATING_GUILT_REGEX.test(text)) return 'eating_guilt';
  if (GENERAL_ANXIETY_REGEX.test(text)) return 'general_anxiety';
  return null;
}

function buildEmotionalSupportMessage(category) {
  switch (category) {
    case 'appearance_anxiety':
      return '一直担心外貌或身材，确实很容易把自己弄得很累。我们先不拿某一种身材标准逼自己，从规律吃饭、精神和体力这些能慢慢改善的地方开始；我会陪你把目标拆小，一步一步往前走。';
    case 'persistence_distress':
      return '坚持不下去其实是身体在提醒节奏太紧了。我们不改全部，先把这一顿调到最轻松能执行的样子，一步一步来。';
    case 'eating_guilt':
      return '吃多一次以后焦虑或自责，确实会让人很难受，但这一顿不会把之前的努力全部推翻。下一顿先恢复正常吃饭，不用故意饿着或过度运动补偿；你把当时吃了什么和大概分量告诉我，我们一起看看后面怎么安排更稳。';
    case 'general_anxiety':
      return '听起来你现在因为这件事有些焦虑，背着这种压力确实会很累。我们先不要求自己一下子做到完美，从今天最容易完成的一小步开始；我会陪你一起把问题拆开，再慢慢找到能坚持的办法。先给你一个轻轻的抱抱～';
    default:
      return null;
  }
}

function isFirstConversationTurn(messages) {
  const humanCount = messages.filter((message) => getMessageRole(message) === 'human').length;
  const aiCount = messages.filter((message) => getMessageRole(message) === 'ai').length;
  return humanCount === 1 && aiCount === 0;
}

async function provideEmotionalSupport(state) {
  const userText = getMessageText(findLastUserMessage(state.messages));
  const category = classifyEmotionalContext(userText);
  const shouldIntroduce = isFirstConversationTurn(state.messages) && !state.longTermContext?.profile;
  const shouldWelcomeBack = Boolean(state.longTermContext?.profile) && RETURNING_GREETING_REGEX.test(userText);
  if (!category) {
    const messages = [
      ...(shouldIntroduce ? [{ role: 'ai', content: FIRST_TURN_INTRO }] : []),
      ...(shouldWelcomeBack ? [{ role: 'ai', content: RETURNING_GREETING }] : []),
    ];
    return messages.length > 0 ? { messages } : {};
  }
  return {
    messages: [
      ...(shouldIntroduce
        ? [{ role: 'ai', content: FIRST_TURN_INTRO }]
        : []),
      ...(shouldWelcomeBack ? [{ role: 'ai', content: RETURNING_GREETING }] : []),
      { role: 'ai', content: buildEmotionalSupportMessage(category) },
    ],
    emotionalSupportDeliveredThisTurn: true,
  };
}

module.exports = {
  provideEmotionalSupport,
  classifyEmotionalContext,
  buildEmotionalSupportMessage,
  RETURNING_GREETING_REGEX,
  RETURNING_GREETING,
};

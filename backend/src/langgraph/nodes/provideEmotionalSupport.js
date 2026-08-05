const { findLastUserMessage, getMessageText, getMessageRole } = require('../utils/messages');
const { FIRST_TURN_INTRO } = require('./askNextQuestion');

const APPEARANCE_ANXIETY_REGEX = /(容貌焦虑|外貌焦虑|身材焦虑|照镜子[^。！？]*(难受|焦虑|崩溃)|觉得自己(?:太胖|很胖|不好看|很丑)|胖死了|丑死了)/;
const PERSISTENCE_DISTRESS_REGEX = /(坚持不下|不想坚持|快坚持不住|想放弃|做不到|没动力|好挫败|很挫败|减不下去|怎么都瘦不下)/;
const EATING_GUILT_REGEX = /(偷吃|吃多了|吃撑了|暴食|管不住嘴|没忍住)[^。！？]*(焦虑|后悔|内疚|自责|怎么办)?/;
const GENERAL_ANXIETY_REGEX = /(好焦虑|很焦虑|特别焦虑|压力好大|压力很大|很难受|心情不好|情绪不好|很崩溃|好崩溃)/;

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
      return '坚持不下去的时候会挫败，这不代表你失败了，也不用靠突然少吃来补救。我们先找出现在最难坚持的一点，只改一个最容易做到的小步骤；中间有反复也可以继续调整，我会陪你一起把节奏找回来。';
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
  if (!category) return {};
  return {
    messages: [
      ...(isFirstConversationTurn(state.messages) ? [{ role: 'ai', content: FIRST_TURN_INTRO }] : []),
      { role: 'ai', content: buildEmotionalSupportMessage(category) },
    ],
    emotionalSupportDeliveredThisTurn: true,
  };
}

module.exports = {
  provideEmotionalSupport,
  classifyEmotionalContext,
  buildEmotionalSupportMessage,
};

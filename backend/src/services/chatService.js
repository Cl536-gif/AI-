const bailianClient = require('./bailianClient');
const userStore = require('./userStore');
const contentSafety = require('./contentSafety');

const INACTIVITY_THRESHOLD_DAYS = Number(process.env.INACTIVITY_THRESHOLD_DAYS) || 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function buildGreetingPrompt(previousActiveAt) {
  if (!previousActiveAt) {
    return '（系统提示：这是该用户第一次打开对话框，请你以"AI秘书"的身份主动打个招呼，自然地开启对话，不要使用生硬的模板句，也不要把这句系统提示读出来。）';
  }

  const daysSinceLastActive = Math.floor(
    (Date.now() - new Date(previousActiveAt).getTime()) / MS_PER_DAY
  );

  if (daysSinceLastActive >= INACTIVITY_THRESHOLD_DAYS) {
    return `（系统提示：该用户已经大约 ${daysSinceLastActive} 天没有来找你聊天了，请你以"AI秘书"的身份，自然地在开场白里体现出这段时间没联系，不要使用生硬的模板句，也不要把这句系统提示读出来。）`;
  }

  return '（系统提示：用户刚打开对话框，请你以"AI秘书"的身份简单打个招呼，开启这次对话，不要使用生硬的模板句，也不要把这句系统提示读出来。）';
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
async function getGreeting({ userId }) {
  const { previousActiveAt } = userStore.recordActivity(userId);
  const prompt = buildGreetingPrompt(previousActiveAt);

  return withSafetyCheck(() => bailianClient.sendMessage({ message: prompt }));
}

/** 用户发送一条普通聊天消息 */
async function sendChatMessage({ userId, message, sessionId }) {
  userStore.recordActivity(userId);

  return withSafetyCheck(() => bailianClient.sendMessage({ message, sessionId }));
}

module.exports = { getGreeting, sendChatMessage };

const { getUserStore } = require('../stores/userStoreProvider');
const { extractGraphEvents } = require('./graphEventExtractionService');
const userService = require('./userService');
const { canRecordLongTermEvents } = require('./longTermService');
const { UserIdSchema } = require('../domain/userDataContract');

function createLongTermEventProcessor({
  store = getUserStore(),
  extractEvents = extractGraphEvents,
} = {}) {
  async function processUserMessage(userId, message, {
    threadId,
    now = new Date().toISOString(),
    timezone = 'Asia/Shanghai',
    store: storeOverride,
  } = {}) {
    const activeStore = storeOverride || store;
    const normalizedUserId = UserIdSchema.parse(userId);

    // 权限检查必须发生在模型抽取之前：无长期服务资格时既不产生模型成本，
    // 也不把免费用户的日常消息送入长期事件处理链。
    if (!await canRecordLongTermEvents(normalizedUserId, { store: activeStore, now })) {
      return {
        status: 'not_entitled',
        extractedCount: 0,
        recordedEvents: [],
      };
    }

    const commands = await extractEvents(message, { threadId, now, timezone });
    const recordedEvents = [];
    // 顺序写入保证与单连接池兼容，也使一条消息拆出的多个事件
    // 按抽取顺序持久化。
    for (const command of commands) {
      recordedEvents.push(await userService.appendEvent(
        normalizedUserId,
        command,
        { store: activeStore, recordedAt: now },
      ));
    }

    return {
      status: 'recorded',
      extractedCount: commands.length,
      recordedEvents,
    };
  }

  return { processUserMessage };
}

const defaultProcessor = createLongTermEventProcessor();

module.exports = {
  createLongTermEventProcessor,
  processLongTermUserMessage: defaultProcessor.processUserMessage,
};

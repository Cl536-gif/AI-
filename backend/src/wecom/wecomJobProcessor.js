const {
  AMBIGUOUS_STOP_MESSAGE,
  CHOICE_RETRY_MESSAGE,
  EXPLICIT_DELETION_MESSAGE,
  FREE_SELECTED_MESSAGE,
  INTRO_MESSAGE,
  LONG_TERM_SELECTED_MESSAGE,
  TEXT_ONLY_MESSAGE,
  classifyWecomContent,
  hashMessage,
} = require('./wecomConversationHandler');
const { processLangGraphConversation } = require('../services/langgraphConversationService');
const userService = require('../services/userService');

function createWecomJobProcessor({
  config,
  store,
  conversationHandler = processLangGraphConversation,
  ensureUser = (userId) => userService.ensureUser(userId),
} = {}) {
  if (!config || !store) throw new TypeError('企业微信任务处理器需要配置和存储');

  return async function processJob({ job, payload }) {
    const userId = await store.resolveIdentity(job.externalSubjectHash, payload.fromUserName);
    await ensureUser(userId);
    const classification = classifyWecomContent(payload);
    let responseText;
    let graphResult = null;
    if (classification === 'unsupported') {
      responseText = TEXT_ONLY_MESSAGE;
    } else if (classification === 'explicit_deletion') {
      await store.recordDeletionRequest({
        userId, requestType: 'explicit_deletion',
        sourceMessageHash: hashMessage(payload.content),
        idempotencyKey: `wecom:${job.messageKey}:explicit_deletion`,
      });
      responseText = EXPLICIT_DELETION_MESSAGE;
    } else if (classification === 'ambiguous_stop') {
      await store.recordDeletionRequest({
        userId, requestType: 'ambiguous_stop',
        sourceMessageHash: hashMessage(payload.content),
        idempotencyKey: `wecom:${job.messageKey}:ambiguous_stop`,
      });
      responseText = AMBIGUOUS_STOP_MESSAGE;
    } else {
      const onboarding = await store.getOnboarding(userId);
      if (!onboarding?.introSentAt) {
        await store.recordIntro(userId, config.introVersion);
        responseText = INTRO_MESSAGE;
      } else if (!onboarding.serviceChoice) {
        if (classification === 'free_choice') {
          await store.setServiceChoice(userId, 'free');
          responseText = FREE_SELECTED_MESSAGE;
        } else if (classification === 'long_term_choice') {
          await store.setServiceChoice(userId, 'subscribed');
          responseText = LONG_TERM_SELECTED_MESSAGE;
        } else {
          responseText = CHOICE_RETRY_MESSAGE;
        }
      } else {
        const initialState = onboarding.graphStartedAt
          ? null : { serviceTier: onboarding.serviceChoice };
        graphResult = await conversationHandler({
          message: payload.content,
          threadId: job.threadId,
          trustedUserId: userId,
          initialState,
          externalTurn: {
            channel: 'wecom', requestId: job.requestId,
            inputSha256: job.inputSha256, operationId: job.graphOperationId,
          },
        });
        if (initialState) await store.markGraphStarted(userId);
        responseText = (graphResult.replies || []).filter(Boolean).join('\n\n') || graphResult.reply;
      }
    }
    return { responseText: String(responseText || ''), userId, graphResult };
  };
}

module.exports = { createWecomJobProcessor };

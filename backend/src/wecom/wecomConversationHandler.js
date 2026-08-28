const crypto = require('crypto');
const { pushService } = require('../pricingConfig');
const { processLangGraphConversation } = require('../services/langgraphConversationService');
const userService = require('../services/userService');

const INTRO_MESSAGE =
  '宝子你好呀，我是你的饮食秘书。现在先在企业微信陪你，后面也会开通小程序和手机应用。\n\n' +
  '免费问答可以随时来找我，但我不会主动推送，也不会持续调整方案。' +
  '如果你想让我按约定时间跟进，并根据每个阶段的记录调整方案，可以进入长期方案，' +
  `前${pushService.trialDays}天免费试用，之后每${pushService.billingCycleDays}天收费${pushService.priceCny}元。\n\n` +
  '直接告诉我“免费问答”或“长期方案”就好。';
const CHOICE_RETRY_MESSAGE =
  '刚才没听清楚。你直接告诉我“免费问答”或“长期方案”就好。';
const FREE_SELECTED_MESSAGE =
  '好，已进入免费问答。你可以直接告诉我现在想了解的饮食问题。';
const LONG_TERM_SELECTED_MESSAGE =
  '好，那我们开始建档。我会一项一项问，不用一次全说完。';
const EXPLICIT_DELETION_MESSAGE =
  '知道了，我已经把你的注销申请记下来了，会尽快安排处理。' +
  '现在是登记成功，账号和资料还没有正式删除，处理完成后我会再告诉你。';
const AMBIGUOUS_STOP_MESSAGE =
  '我记下你不想继续用了。为了不误删账号和资料，我会先把这条记为待确认，处理前再跟你确认一次。';
const TEXT_ONLY_MESSAGE = '内部测试阶段暂时只支持文字消息。';

const EXPLICIT_DELETION_REGEX = /(?:注销|删除)(?:我的)?(?:账号|帐号|资料|个人信息|档案)|(?:账号|帐号|资料|档案).{0,4}(?:注销|删除)/u;
const AMBIGUOUS_STOP_REGEX = /^(?:我)?(?:不想用了|先不用了|不用了|不想继续了)[。！!~～\s]*$/u;
const FREE_CHOICE_REGEX = /^(?:免费问答|免费|先用免费问答)[。！!~～\s]*$/u;
const LONG_TERM_CHOICE_REGEX = /^(?:长期方案|长期规划|我选长期方案)[。！!~～\s]*$/u;

function classifyWecomContent(message) {
  if (message.msgType !== 'text') return 'unsupported';
  const content = String(message.content || '');
  if (EXPLICIT_DELETION_REGEX.test(content)) return 'explicit_deletion';
  if (AMBIGUOUS_STOP_REGEX.test(content.trim())) return 'ambiguous_stop';
  if (FREE_CHOICE_REGEX.test(content.trim())) return 'free_choice';
  if (LONG_TERM_CHOICE_REGEX.test(content.trim())) return 'long_term_choice';
  return 'conversation';
}

function hashSubject(corpId, fromUserName) {
  return crypto.createHash('sha256')
    .update(`diet-secretary-wecom:v1:${corpId}:${fromUserName}`)
    .digest('hex');
}

function hashMessage(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function createWecomConversationHandler({
  config,
  store,
  conversationHandler = processLangGraphConversation,
  ensureUser = (userId) => userService.ensureUser(userId),
} = {}) {
  if (!config || !store) throw new Error('创建企业微信对话处理器需要配置和存储');

  return async function handleWecomMessage(message) {
    const externalSubjectHash = hashSubject(config.corpId, message.fromUserName);
    if (!config.testAllowlist.includes(externalSubjectHash)) {
      const error = new Error('当前企业微信成员不在内部测试白名单');
      error.code = 'WECOM_TEST_USER_NOT_ALLOWED';
      error.statusCode = 403;
      throw error;
    }

    const userId = store.resolveIdentity(externalSubjectHash);
    await ensureUser(userId);
    const messageKey = message.msgId || hashMessage(
      `${externalSubjectHash}:${message.createTime}:${message.msgType}:${message.content}`
    );
    const started = store.beginMessage(messageKey, userId);
    if (!started.isNew && started.status === 'completed') return started.responseText;
    if (!started.isNew && started.status === 'processing') {
      const error = new Error('企业微信重复消息正在处理');
      error.code = 'WECOM_MESSAGE_IN_PROGRESS';
      error.statusCode = 409;
      throw error;
    }

    try {
      let responseText;
      if (message.msgType !== 'text') {
        responseText = TEXT_ONLY_MESSAGE;
      } else if (EXPLICIT_DELETION_REGEX.test(message.content)) {
        store.recordDeletionRequest({
          userId,
          requestType: 'explicit_deletion',
          sourceMessageHash: hashMessage(message.content),
          idempotencyKey: `wecom:${messageKey}:explicit_deletion`,
        });
        responseText = EXPLICIT_DELETION_MESSAGE;
      } else if (AMBIGUOUS_STOP_REGEX.test(message.content.trim())) {
        store.recordDeletionRequest({
          userId,
          requestType: 'ambiguous_stop',
          sourceMessageHash: hashMessage(message.content),
          idempotencyKey: `wecom:${messageKey}:ambiguous_stop`,
        });
        responseText = AMBIGUOUS_STOP_MESSAGE;
      } else {
        const onboarding = store.getOnboarding(userId);
        if (!onboarding?.introSentAt) {
          store.recordIntro(userId, config.introVersion);
          responseText = INTRO_MESSAGE;
        } else if (!onboarding.serviceChoice) {
          if (FREE_CHOICE_REGEX.test(message.content.trim())) {
            store.setServiceChoice(userId, 'free');
            responseText = FREE_SELECTED_MESSAGE;
          } else if (LONG_TERM_CHOICE_REGEX.test(message.content.trim())) {
            store.setServiceChoice(userId, 'subscribed');
            responseText = LONG_TERM_SELECTED_MESSAGE;
          } else {
            responseText = CHOICE_RETRY_MESSAGE;
          }
        } else {
          const initialState = store.getInitialGraphState(userId);
          const result = await conversationHandler({
            message: message.content,
            threadId: `wecom:${externalSubjectHash}`,
            trustedUserId: userId,
            initialState,
          });
          if (initialState) store.markGraphStarted(userId);
          responseText = (result.replies || []).filter(Boolean).join('\n\n') || result.reply;
        }
      }
      store.completeMessage(messageKey, responseText);
      return responseText;
    } catch (error) {
      store.failMessage(messageKey);
      throw error;
    }
  };
}

module.exports = {
  AMBIGUOUS_STOP_MESSAGE,
  CHOICE_RETRY_MESSAGE,
  EXPLICIT_DELETION_MESSAGE,
  FREE_SELECTED_MESSAGE,
  INTRO_MESSAGE,
  LONG_TERM_SELECTED_MESSAGE,
  TEXT_ONLY_MESSAGE,
  classifyWecomContent,
  createWecomConversationHandler,
  hashMessage,
  hashSubject,
};

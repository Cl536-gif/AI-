const crypto = require('crypto');
const { workflow } = require('../langgraph/graph');
const { createLangGraphCheckpointer } = require('../langgraph/checkpointerProvider');
const { resolveInternalThreadId } = require('../langgraph/threadScope');
const { getPostgresPool } = require('../db/postgresPool');
const {
  invokeGraphWithCheckpointerPolicy,
  withGraphThreadPolicy,
} = require('../langgraph/httpCanaryBoundary');
const { sanitize: sanitizeEnglish } = require('./contentSafety');
const { resolveAnonymousUser } = require('./identityService');
const userService = require('./userService');
const { detectExplicitTimezone, detectExplicitMealTarget } = require('./userTimeService');
const {
  prepareGraphContext,
  persistGraphTurn,
} = require('./graphPersistenceCoordinator');
const {
  classifyExternalTurnSnapshot,
  isRetryOfRecoveredTurn,
  normalizeExternalTurn,
  persistAndAcknowledgeGraphTurn,
  recoverPendingGraphTurn,
} = require('./graphTurnPersistenceRecovery');
const {
  looksLikePrivacyRequest,
  classifyPrivacyOnboardingMessage,
  PRIVACY_POLICY_SUMMARY,
  PRIVACY_LATER_REMINDER,
} = require('./chatService');

const GLOBAL_PRIVACY_FOLLOW_UP =
  '以上是最重要的几条。还有隐私问题可以继续问我；如果没有，直接接着回答刚才的问题就好。';

const { checkpointer, policy: checkpointerPolicy } = createLangGraphCheckpointer();
const graphWithCheckpointer = workflow.compile({ checkpointer });

function getMessageRole(message) {
  if (!message) return undefined;
  if (typeof message.role === 'string') return message.role;
  if (typeof message._getType === 'function') {
    return message._getType() === 'human' ? 'human' : message._getType();
  }
  return undefined;
}

function formatLongReplyForReadability(text) {
  const value = String(text || '').trim();
  if (value.length <= 180 || value.includes('\n')) return value;
  const sentences = value.match(/[^。！？!?]+[。！？!?～~]?/g) || [value];
  const paragraphs = [];
  let current = '';
  sentences.forEach((sentence) => {
    if (current && current.length + sentence.length > 85) {
      paragraphs.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  });
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs.join('\n\n');
}

function sanitizeUserVisibleReply(text) {
  const normalizedCommonTerms = String(text || '')
    .replace(/\bOK\b/gi, '可以')
    .replace(/\bAI\b/g, '智能秘书')
    .replace(/当前数据库没有保存到可读取的历史建议(?:（为空）)?/g, '之前给过的临时搭配没有完整存进这份档案里')
    .replace(/没有被系统持久化存档/g, '当时没有完整存进这份档案')
    .replace(/[（(](?:为空|null|NULL)[）)]/g, '')
    .replace(/数据库里?没有(?:保存|找到)到?可读取的?/g, '这份档案里暂时没有')
    .replace(/等你吃完[、，,\s]*有感觉了[，,\s]*/g, '等你吃完，如果分量不够、很快又饿或者哪里不舒服，')
    .replace(/吃完后?[、，,\s]*有感觉(?:了)?[，,\s]*/g, '吃完后如果分量不够、很快又饿或者哪里不舒服，');
  const sanitized = sanitizeEnglish(normalizedCommonTerms).replace(/(?:—+|－{2,}|-{2,})/g, '，');
  return formatLongReplyForReadability(sanitized);
}

function stripLongTermMetaJustification(text, longTermContext) {
  const value = String(text || '').trim();
  if (longTermContext?.accessMode !== 'long_term') return value;
  const isMetaJustification = (paragraph) =>
    /(?:这个|这份|以上|本次).{0,10}(?:搭配|安排|方案).{0,18}(?:结合|根据|按照)/u.test(paragraph) &&
    /(?:预算|食堂|就餐|口味|偏好|目标|档案|记录)/u.test(paragraph);
  const paragraphs = value.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const kept = paragraphs.filter((paragraph) => !isMetaJustification(paragraph));
  return (kept.length ? kept : paragraphs).join('\n\n');
}

function identityNotProvidedPersistence() {
  return {
    profilePersistence: { status: 'identity_not_provided', profile: null },
    advicePersistence: { status: 'identity_not_provided', records: [] },
    serviceStatus: null,
    eventPersistence: { status: 'identity_not_provided', recordedEvents: [] },
    planAdjustment: { status: 'not_evaluated', action: 'none', reason: 'identity_not_provided' },
    planRecovery: { status: 'not_applicable', action: 'none', reason: 'identity_not_provided' },
    planRevision: { status: 'not_requested', plan: null },
    initialLongTermPlan: { status: 'not_requested', plan: null },
  };
}

function recoveredPersistenceSummary() {
  return {
    profilePersistence: { status: 'unchanged', profile: null },
    advicePersistence: { status: 'unchanged', records: [] },
    serviceStatus: null,
    eventPersistence: { status: 'unchanged', recordedEvents: [] },
    planAdjustment: { status: 'not_evaluated', action: 'none' },
    planRecovery: { status: 'not_applicable', action: 'none' },
    planRevision: { status: 'not_requested', plan: null },
    initialLongTermPlan: { status: 'not_requested', plan: null },
  };
}

function getGraphReplies(result, longTermContext) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const lastHumanIndex = messages.map((item) => getMessageRole(item)).lastIndexOf('human');
  return messages
    .slice(lastHumanIndex + 1)
    .filter((item) => getMessageRole(item) !== 'human' && item.content)
    .map((item) => sanitizeUserVisibleReply(item.content))
    .map((item) => stripLongTermMetaJustification(item, longTermContext));
}

async function writeExternalTurnReceipt({ graph, config, externalTurn, result, reply }) {
  if (!externalTurn) return null;
  const receipt = {
    requestId: externalTurn.requestId,
    inputSha256: externalTurn.inputSha256,
    operationId: externalTurn.operationId,
    replySha256: crypto.createHash('sha256').update(String(reply || ''), 'utf8').digest('hex'),
    completedAt: new Date().toISOString(),
  };
  await graph.updateState(config, { externalTurnReceipt: receipt });
  return receipt;
}

async function processLangGraphConversation({
  message,
  threadId,
  deviceId,
  trustedUserId,
  introAlreadyShown = false,
  privacyOnboarding = false,
  testPersona,
  initialState = null,
  httpCanaryControls = { holdMs: 0, failAfterIdentity: false, failAfterAdvicePersistence: false },
  httpCanaryInstanceFingerprint = null,
  externalTurn = null,
} = {}) {
  const resolvedThreadId = threadId && threadId.trim() ? threadId.trim() : crypto.randomUUID();
  let graphMessage = String(message || '').trim();
  let prefixReplies = [];

  if (privacyOnboarding) {
    const privacyAction = classifyPrivacyOnboardingMessage(graphMessage);
    if (privacyAction === 'policy') {
      return {
        reply: GLOBAL_PRIVACY_FOLLOW_UP,
        replies: [PRIVACY_POLICY_SUMMARY, GLOBAL_PRIVACY_FOLLOW_UP],
        threadId: null,
        privacyOnboardingPending: true,
        globalCommand: 'privacy_policy',
      };
    }
    if (privacyAction !== 'continue') {
      const prompt = '想查看隐私政策重点，请回复“1”；已经了解并想开始，请回复“2”或“继续”。';
      return {
        reply: prompt,
        replies: [prompt],
        threadId: null,
        privacyOnboardingPending: true,
        globalCommand: 'privacy_choice_pending',
      };
    }
    graphMessage = '开始了解饮食习惯';
    prefixReplies = [PRIVACY_LATER_REMINDER];
  }

  if (looksLikePrivacyRequest(graphMessage)) {
    return {
      reply: GLOBAL_PRIVACY_FOLLOW_UP,
      replies: [PRIVACY_POLICY_SUMMARY, GLOBAL_PRIVACY_FOLLOW_UP],
      threadId: threadId && threadId.trim() ? threadId.trim() : null,
      globalCommand: 'privacy_policy',
    };
  }

  const resolvedUserId = trustedUserId || (deviceId ? await resolveAnonymousUser(deviceId) : null);
  if (resolvedUserId && trustedUserId) await userService.ensureUser(resolvedUserId);
  if (httpCanaryControls.failAfterIdentity) {
    const error = new Error('005h受控故障已在身份解析后触发');
    error.code = 'HTTP_CANARY_FAULT_AFTER_IDENTITY';
    error.statusCode = 503;
    throw error;
  }

  const internalThreadId = resolveInternalThreadId({
    publicThreadId: resolvedThreadId,
    userId: resolvedUserId,
    checkpointerPolicy,
  });
  const config = { configurable: { thread_id: internalThreadId } };
  const explicitTimezone = detectExplicitTimezone(graphMessage);
  if (resolvedUserId && explicitTimezone) {
    await userService.updateTimezone(resolvedUserId, explicitTimezone);
  }
  let longTermContext = resolvedUserId ? await prepareGraphContext(resolvedUserId) : null;
  if (longTermContext?.temporalContext) {
    longTermContext.temporalContext.explicitMealTarget = detectExplicitMealTarget(graphMessage);
  }
  if (longTermContext && testPersona) longTermContext.developerTestPersona = testPersona;

  const normalizedExternalTurn = externalTurn ? normalizeExternalTurn(externalTurn) : null;
  const inputMessages = [];
  if (!threadId && introAlreadyShown) {
    inputMessages.push({
      role: 'ai',
      content: '我是你的饮食秘书，会结合你的日常情况提供生活化饮食建议。',
    });
  }
  inputMessages.push({
    role: 'human',
    content: graphMessage,
    ...(normalizedExternalTurn ? { id: `wecom:${normalizedExternalTurn.requestId}` } : {}),
  });
  const isHomepageHandoff = !threadId && introAlreadyShown;
  let httpCanaryLockWaitMs = null;
  const graphInput = {
    ...(initialState || {}),
    messages: inputMessages,
    longTermContext,
    ...(normalizedExternalTurn ? {
      externalTurnRequest: normalizedExternalTurn,
      persistenceRequest: { operationId: normalizedExternalTurn.operationId },
    } : {}),
    ...(isHomepageHandoff ? { lastAskedSlot: 'scene' } : {}),
  };

  let result;
  let persistence;
  let externalRecoveryStatus = normalizedExternalTurn ? 'fresh' : null;
  if ((checkpointerPolicy.requiresThreadLock || normalizedExternalTurn) && resolvedUserId) {
    const operationId = normalizedExternalTurn?.operationId || crypto.randomUUID();
    const turn = await withGraphThreadPolicy({
      config,
      policy: checkpointerPolicy,
      holdMs: httpCanaryControls.holdMs,
      onLockAcquired: ({ waitMs }) => { httpCanaryLockWaitMs = waitMs; },
      work: async () => {
        if (normalizedExternalTurn) {
          const snapshot = await graphWithCheckpointer.getState(config);
          const classification = classifyExternalTurnSnapshot(snapshot, normalizedExternalTurn);
          externalRecoveryStatus = classification.status;
          if (classification.status === 'conflict') {
            throw Object.assign(new Error('企业微信任务与LangGraph checkpoint标记冲突'), {
              code: 'WECOM_GRAPH_STATE_CONFLICT',
            });
          }
          if (classification.status === 'complete' || classification.status === 'receipt_pending') {
            return { result: classification.state, persistence: null };
          }
          if (classification.status === 'checkpoint_incomplete') {
            const resumedResult = await graphWithCheckpointer.invoke(null, config);
            const resumedPersistence = await persistAndAcknowledgeGraphTurn({
              graph: graphWithCheckpointer,
              config,
              userId: resolvedUserId,
              threadId: resolvedThreadId,
              state: resumedResult,
              operationId,
              persistTurn: persistGraphTurn,
            });
            return { result: resumedResult, persistence: resumedPersistence };
          }
          if (classification.status === 'persistence_pending') {
            const recovered = await recoverPendingGraphTurn({
              graph: graphWithCheckpointer,
              config,
              userId: resolvedUserId,
              threadId: resolvedThreadId,
              persistTurn: persistGraphTurn,
            });
            return { result: recovered.state, persistence: recovered.persistence };
          }
        }
        const recovery = await recoverPendingGraphTurn({
          graph: graphWithCheckpointer,
          config,
          userId: resolvedUserId,
          threadId: resolvedThreadId,
          persistTurn: persistGraphTurn,
        });
        if (recovery.status === 'recovered') {
          longTermContext = await prepareGraphContext(resolvedUserId);
          if (longTermContext?.temporalContext) {
            longTermContext.temporalContext.explicitMealTarget =
              detectExplicitMealTarget(graphMessage);
          }
          if (longTermContext && testPersona) {
            longTermContext.developerTestPersona = testPersona;
          }
        }
        if (isRetryOfRecoveredTurn(recovery, graphMessage)) {
          return { result: recovery.state, persistence: recovery.persistence };
        }
        const lockedResult = await graphWithCheckpointer.invoke({
          ...graphInput,
          longTermContext,
          persistenceRequest: { operationId },
        }, config);
        const lockedPersistence = await persistAndAcknowledgeGraphTurn({
          graph: graphWithCheckpointer,
          config,
          userId: resolvedUserId,
          threadId: resolvedThreadId,
          state: lockedResult,
          operationId,
          persistTurn: persistGraphTurn,
          afterStep: httpCanaryControls.failAfterAdvicePersistence
            ? ({ step }) => {
                if (step === 'advice') {
                  throw Object.assign(new Error('005m受控故障已在建议持久化后触发'), {
                    code: 'HTTP_CANARY_FAULT_AFTER_ADVICE_PERSISTENCE',
                    statusCode: 503,
                  });
                }
              }
            : null,
        });
        return { result: lockedResult, persistence: lockedPersistence };
      },
    });
    result = turn.result;
    persistence = turn.persistence || recoveredPersistenceSummary();
  } else {
    result = await invokeGraphWithCheckpointerPolicy({
      graph: graphWithCheckpointer,
      input: graphInput,
      config,
      policy: checkpointerPolicy,
      holdMs: httpCanaryControls.holdMs,
      onLockAcquired: ({ waitMs }) => { httpCanaryLockWaitMs = waitMs; },
    });
    persistence = resolvedUserId
      ? await persistGraphTurn(resolvedUserId, graphMessage, resolvedThreadId, result)
      : identityNotProvidedPersistence();
  }

  const graphReplies = getGraphReplies(result, longTermContext);
  if (prefixReplies.length && graphReplies.length) {
    graphReplies[0] = graphReplies[0].replace(/^你好呀?[～~，,\s]*/u, '').trim();
  }
  const replies = [...prefixReplies, ...graphReplies];
  const reply = replies[replies.length - 1] || '';
  const externalTurnReceipt = normalizedExternalTurn
    ? (result.externalTurnReceipt || await writeExternalTurnReceipt({
        graph: graphWithCheckpointer,
        config,
        externalTurn: normalizedExternalTurn,
        result,
        reply,
      }))
    : null;

  return {
    reply,
    replies,
    threadId: resolvedThreadId,
    privacyOnboardingPending: false,
    identityStatus: trustedUserId
      ? 'authenticated_channel'
      : (resolvedUserId ? 'anonymous_resolved' : 'not_provided'),
    profilePersistence: persistence.profilePersistence.status,
    advicePersistence: persistence.advicePersistence.status,
    serviceStatus: persistence.serviceStatus?.status || 'free',
    eventPersistence: persistence.eventPersistence.status,
    planAdjustment: persistence.planAdjustment?.action || 'none',
    planRecovery: persistence.planRecovery?.action || 'none',
    planRevision: persistence.planRevision?.status || 'not_requested',
    activePlanVersion: persistence.planRevision?.plan?.planVersion || null,
    initialLongTermPlan: persistence.initialLongTermPlan?.status || 'not_requested',
    initialOfficialPlanId: persistence.initialLongTermPlan?.plan?.planId || null,
    contextAccessMode: longTermContext?.accessMode || 'identity_not_provided',
    userTimezone: longTermContext?.temporalContext?.timezone || null,
    localDate: longTermContext?.temporalContext?.localDate || null,
    localWeekday: longTermContext?.temporalContext?.weekday || null,
    mealTiming: longTermContext?.temporalContext?.mealTiming || null,
    explicitMealTarget: longTermContext?.temporalContext?.explicitMealTarget || null,
    slots: result.slots,
    cafeteriaMode: result.slots?.cafeteriaMode?.value || null,
    isComplete: result.isComplete,
    initialPlanDelivered: Boolean(result.initialPlanDelivered),
    serviceTier: result.serviceTier,
    equationSex: result.equationSex,
    pushSchedule: result.pushSchedule,
    bodyOnboardingStatus: result.bodyOnboardingStatus,
    bodyProfile: result.bodyProfile || {},
    cycleOnboardingStatus: result.cycleOnboardingStatus,
    menstrualProfile: result.menstrualProfile,
    retrieved: result.retrieved || [],
    ...(normalizedExternalTurn ? {
      externalTurnReceipt,
      externalTurnRecoveryStatus: externalRecoveryStatus,
    } : {}),
    ...(checkpointerPolicy.httpCanary ? {
      canaryInstanceFingerprint: httpCanaryInstanceFingerprint,
      canaryLockWaitMs: httpCanaryLockWaitMs,
      canaryPoolWaiting: getPostgresPool().waitingCount,
    } : {}),
  };
}

module.exports = {
  checkpointerPolicy,
  processLangGraphConversation,
  sanitizeUserVisibleReply,
  formatLongReplyForReadability,
  stripLongTermMetaJustification,
};

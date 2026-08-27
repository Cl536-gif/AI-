// LangGraph 版本的对话链路：跟 /api/chat（百炼App）、/api/chat-local
// （本地知识库+纯提示词）完全独立，互不影响。核心差异是这条链路用
// 显式的状态机（六项信息各自 {value, confirmed}）管理采集流程，不再
// 依赖模型自己从对话历史里"回忆"当前进度——用来解决场景值前后矛盾、
// 完整信息被无视重新采集、改口未被识别这三个纯提示词架构下反复出现
// 的状态一致性问题。
//
// checkpointer由Provider选择：默认SQLite部署仍使用MemorySaver；只有满足
// 独立确认、schema、身份作用域和拓扑门禁的受控灰度才可使用PostgreSQL。
// 双实例HTTP灰度还必须通过服务端令牌，并在完整graph invoke外持有同一
// thread的advisory lock。客户端仍只携带公开threadId，数据库只接触服务端
// 派生的内部thread键。
const express = require('express');
const crypto = require('crypto');
const { workflow } = require('../langgraph/graph');
const { createLangGraphCheckpointer } = require('../langgraph/checkpointerProvider');
const { resolveInternalThreadId } = require('../langgraph/threadScope');
const {
  FAULT_HEADER,
  HOLD_HEADER,
  TOKEN_HEADER,
  assertHttpCanaryRequest,
  invokeGraphWithCheckpointerPolicy,
  resolveHttpCanaryFaultControls,
  resolveHttpCanaryInstanceFingerprint,
  withGraphThreadPolicy,
} = require('../langgraph/httpCanaryBoundary');
const { sanitize: sanitizeEnglish } = require('../services/contentSafety');
const { resolveAnonymousUser, validateDeviceId } = require('../services/identityService');
const userService = require('../services/userService');
const { detectExplicitTimezone, detectExplicitMealTarget } = require('../services/userTimeService');
const {
  prepareGraphContext,
  persistGraphTurn,
} = require('../services/graphPersistenceCoordinator');
const {
  isRetryOfRecoveredTurn,
  persistAndAcknowledgeGraphTurn,
  recoverPendingGraphTurn,
} = require('../services/graphTurnPersistenceRecovery');
const {
  looksLikePrivacyRequest,
  classifyPrivacyOnboardingMessage,
  PRIVACY_POLICY_SUMMARY,
  PRIVACY_LATER_REMINDER,
} = require('../services/chatService');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;
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

router.post('/', async (req, res, next) => {
  const {
    message, threadId, deviceId, introAlreadyShown, privacyOnboarding, testPersona,
  } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: '消息内容过长' });
  }
  if (threadId !== undefined && typeof threadId !== 'string') {
    return res.status(400).json({ error: 'threadId 格式不正确' });
  }
  if (introAlreadyShown !== undefined && typeof introAlreadyShown !== 'boolean') {
    return res.status(400).json({ error: 'introAlreadyShown 格式不正确' });
  }
  if (privacyOnboarding !== undefined && typeof privacyOnboarding !== 'boolean') {
    return res.status(400).json({ error: 'privacyOnboarding 格式不正确' });
  }
  const allowedTestPersonas = new Set([
    'new_contact', 'free', 'long_term',
    'long_term_day2', 'long_term_day8', 'long_term_plateau',
  ]);
  if (testPersona !== undefined &&
      (process.env.NODE_ENV === 'production' || !allowedTestPersonas.has(testPersona))) {
    return res.status(400).json({ error: 'testPersona 格式不正确' });
  }
  if (deviceId !== undefined) {
    try {
      validateDeviceId(deviceId);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  let httpCanaryControls;
  let httpCanaryInstanceFingerprint;
  try {
    assertHttpCanaryRequest({
      policy: checkpointerPolicy,
      token: req.get(TOKEN_HEADER),
    });
    httpCanaryControls = resolveHttpCanaryFaultControls({
      policy: checkpointerPolicy,
      holdMs: req.get(HOLD_HEADER),
      fault: req.get(FAULT_HEADER),
    });
    httpCanaryInstanceFingerprint = resolveHttpCanaryInstanceFingerprint({
      policy: checkpointerPolicy,
    });
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return next(error);
  }

  const resolvedThreadId = threadId && threadId.trim() ? threadId.trim() : crypto.randomUUID();

  try {
    let graphMessage = message.trim();
    let prefixReplies = [];

    // 数字选项只在服务器明确知道“当前正在等待隐私选择”时代表隐私命令。
    // 进入正式对话后，后续任何1/2都只交给同一个LangGraph线程按当前问题解释。
    if (privacyOnboarding) {
      const privacyAction = classifyPrivacyOnboardingMessage(graphMessage);
      if (privacyAction === 'policy') {
        return res.json({
          reply: GLOBAL_PRIVACY_FOLLOW_UP,
          replies: [PRIVACY_POLICY_SUMMARY, GLOBAL_PRIVACY_FOLLOW_UP],
          threadId: null,
          privacyOnboardingPending: true,
          globalCommand: 'privacy_policy',
        });
      }
      if (privacyAction !== 'continue') {
        const prompt = '想查看隐私政策重点，请回复“1”；已经了解并想开始，请回复“2”或“继续”。';
        return res.json({
          reply: prompt,
          replies: [prompt],
          threadId: null,
          privacyOnboardingPending: true,
          globalCommand: 'privacy_choice_pending',
        });
      }
      graphMessage = '开始了解饮食习惯';
      prefixReplies = [PRIVACY_LATER_REMINDER];
    }

    // 隐私政策是全局指令：进入 LangGraph 后仍可随时查看，但查看本身
    // 不推进、不清空当前饮食采集状态。用户下一条继续回答原问题即可。
    if (looksLikePrivacyRequest(graphMessage)) {
      return res.json({
        reply: GLOBAL_PRIVACY_FOLLOW_UP,
        replies: [PRIVACY_POLICY_SUMMARY, GLOBAL_PRIVACY_FOLLOW_UP],
        threadId: threadId && threadId.trim() ? threadId.trim() : null,
        globalCommand: 'privacy_policy',
      });
    }

    // 正式账号身份以后只能从服务端认证上下文取得，绝不接受请求正文里的
    // userId。当前 deviceId 只映射为内部 anon:* 身份；档案与事件写入必须
    // 经过 graphPersistenceCoordinator 的权限边界。
    const anonymousUserId = deviceId ? await resolveAnonymousUser(deviceId) : null;
    if (httpCanaryControls.failAfterIdentity) {
      return res.status(503).json({
        error: '005h受控故障已在身份解析后触发',
        code: 'HTTP_CANARY_FAULT_AFTER_IDENTITY',
      });
    }
    const internalThreadId = resolveInternalThreadId({
      publicThreadId: resolvedThreadId,
      userId: anonymousUserId,
      checkpointerPolicy,
    });
    const config = { configurable: { thread_id: internalThreadId } };
    const explicitTimezone = detectExplicitTimezone(graphMessage);
    if (anonymousUserId && explicitTimezone) {
      await userService.updateTimezone(anonymousUserId, explicitTimezone);
    }
    let longTermContext = anonymousUserId ? await prepareGraphContext(anonymousUserId) : null;
    if (longTermContext?.temporalContext) {
      longTermContext.temporalContext.explicitMealTarget = detectExplicitMealTarget(graphMessage);
    }
    if (longTermContext && testPersona) longTermContext.developerTestPersona = testPersona;
    const inputMessages = [];
    if (!threadId && introAlreadyShown) {
      inputMessages.push({
        role: 'ai',
        content: '我是你的饮食秘书，会结合你的日常情况提供生活化饮食建议。',
      });
    }
    inputMessages.push({ role: 'human', content: graphMessage });
    const isHomepageHandoff = !threadId && introAlreadyShown;
    let httpCanaryLockWaitMs = null;
    const graphInput = {
      messages: inputMessages,
      longTermContext,
      // 首页的“食堂还是外卖”由 /api/chat 发出，第一条答案才切到
      // LangGraph。必须把上一问的字段显式带进状态，否则“食堂”能靠
      // 关键词识别，但“都吃/换着吃”这类依赖上下文的省略回答会丢失。
      ...(isHomepageHandoff ? { lastAskedSlot: 'scene' } : {}),
    };
    const identityNotProvidedPersistence = {
          profilePersistence: { status: 'identity_not_provided', profile: null },
          advicePersistence: { status: 'identity_not_provided', records: [] },
          serviceStatus: null,
          eventPersistence: { status: 'identity_not_provided', recordedEvents: [] },
          planAdjustment: { status: 'not_evaluated', action: 'none', reason: 'identity_not_provided' },
          planRecovery: { status: 'not_applicable', action: 'none', reason: 'identity_not_provided' },
          planRevision: { status: 'not_requested', plan: null },
          initialLongTermPlan: { status: 'not_requested', plan: null },
    };
    let result;
    let persistence;
    if (checkpointerPolicy.requiresThreadLock && anonymousUserId) {
      const operationId = crypto.randomUUID();
      const turn = await withGraphThreadPolicy({
        config,
        policy: checkpointerPolicy,
        holdMs: httpCanaryControls.holdMs,
        onLockAcquired: ({ waitMs }) => { httpCanaryLockWaitMs = waitMs; },
        work: async () => {
          const recovery = await recoverPendingGraphTurn({
            graph: graphWithCheckpointer,
            config,
            userId: anonymousUserId,
            threadId: resolvedThreadId,
            persistTurn: persistGraphTurn,
          });
          // 恢复可能刚写入档案、服务状态或长期事件；当前轮必须重新读取
          // 上下文，不能继续使用锁外取得的旧快照。
          if (recovery.status === 'recovered') {
            longTermContext = await prepareGraphContext(anonymousUserId);
            if (longTermContext?.temporalContext) {
              longTermContext.temporalContext.explicitMealTarget =
                detectExplicitMealTarget(graphMessage);
            }
            if (longTermContext && testPersona) {
              longTermContext.developerTestPersona = testPersona;
            }
          }
          // HTTP故障后的客户端通常会原样重发同一消息。旧轮次副作用恢复
          // 完成后直接复用该checkpoint结果，不能再次invoke让对话前进
          // 第二次。只有不同的新消息才进入下一轮图执行。
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
            userId: anonymousUserId,
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
      persistence = turn.persistence;
    } else {
      result = await invokeGraphWithCheckpointerPolicy({
        graph: graphWithCheckpointer,
        input: graphInput,
        config,
        policy: checkpointerPolicy,
        holdMs: httpCanaryControls.holdMs,
        onLockAcquired: ({ waitMs }) => { httpCanaryLockWaitMs = waitMs; },
      });
      persistence = anonymousUserId
        ? await persistGraphTurn(anonymousUserId, graphMessage, resolvedThreadId, result)
        : identityNotProvidedPersistence;
    }

    const lastHumanIndex = result.messages.map((item) => getMessageRole(item)).lastIndexOf('human');
    const graphReplies = result.messages
      .slice(lastHumanIndex + 1)
      .filter((item) => getMessageRole(item) !== 'human' && item.content)
      .map((item) => sanitizeUserVisibleReply(item.content))
      .map((item) => stripLongTermMetaJustification(item, longTermContext));
    if (prefixReplies.length && graphReplies.length) {
      graphReplies[0] = graphReplies[0].replace(/^你好呀?[～~，,\s]*/u, '').trim();
    }
    const replies = [
      ...prefixReplies,
      ...graphReplies,
    ];
    const reply = replies[replies.length - 1] || '';

    res.json({
      reply,
      replies,
      threadId: resolvedThreadId,
      privacyOnboardingPending: false,
      identityStatus: anonymousUserId ? 'anonymous_resolved' : 'not_provided',
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
      // isComplete 现在只代表"六项信息问完"，不代表方案已经生成——
      // 六项问完之后还要先经过 askServiceChoice 这一步，plan 是否真的
      // 已经生成，看 retrieved 是否非空（只有 generatePlan 才会填这项）
      // 更准确；serviceTier/pushSchedule 供前端/测试脚本观察这个新分岔
      // 的状态。
      serviceTier: result.serviceTier,
      equationSex: result.equationSex,
      pushSchedule: result.pushSchedule,
      bodyOnboardingStatus: result.bodyOnboardingStatus,
      bodyProfile: result.bodyProfile || {},
      cycleOnboardingStatus: result.cycleOnboardingStatus,
      menstrualProfile: result.menstrualProfile,
      retrieved: result.retrieved || [],
      ...(checkpointerPolicy.httpCanary ? {
        canaryInstanceFingerprint: httpCanaryInstanceFingerprint,
        canaryLockWaitMs: httpCanaryLockWaitMs,
      } : {}),
    });
  } catch (err) {
    if (Number.isInteger(err?.statusCode)) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

module.exports = router;
module.exports.sanitizeUserVisibleReply = sanitizeUserVisibleReply;
module.exports.formatLongReplyForReadability = formatLongReplyForReadability;
module.exports.stripLongTermMetaJustification = stripLongTermMetaJustification;

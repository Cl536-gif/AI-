const crypto = require('crypto');
const express = require('express');
const userStore = require('../services/userStore');
const { resolveAnonymousUser, validateDeviceId } = require('../services/identityService');
const { buildLongTermTimeline } = require('../services/longTermTimelineService');
const { DEFAULT_TIMEZONE, formatTemporalContext } = require('../services/userTimeService');
const { calculateAndRecordAdultEnergy } = require('../services/energyCalculationService');
const { createStagePlanDraft, markOfficialPlanDelivered } = require('../services/stagePlanService');

const router = express.Router();
const TEST_PERSONAS = new Set([
  'new_contact', 'free', 'long_term',
  'long_term_day2', 'long_term_day8', 'long_term_plateau',
]);
const DAY_MS = 24 * 60 * 60 * 1000;

function atDaysAgo(now, daysAgo) {
  return new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
}

function seedEvent(userId, eventType, occurredAt, payload, idempotencyKey) {
  userStore.appendEvent({
    userId, eventType, occurredAt, recordedAt: occurredAt, payload,
    source: 'system', idempotencyKey,
  });
}

async function ensureLongTermFixture(userId, { persona, now, trialStartedAt }) {
  if (!userStore.getProfile(userId)) {
    userStore.updateProfile(userId, {
      body: {
        equationSex: 'female', ageYears: 22, heightCm: 165,
        currentWeightKg: 60, targetWeightKg: 55,
        dailyActivity: '日常以久坐上课为主', recentWeightChange: '近期变化不明显',
      },
      diet: {
        scene: 'cafeteria', cafeteriaMode: 'self_select', budgetCnyPerMeal: 30,
        tastePreferences: ['酸甜口味'], restrictions: [],
        goals: ['拍照更上镜'], exerciseBaseline: '目前没有固定运动安排',
      },
    }, { source: 'developer_fixture', now: trialStartedAt });
  }

  let activePlan = userStore.getActivePlan(userId);
  if (!activePlan) {
    const calculation = userStore.listEnergyCalculations(userId, { limit: 1 })[0] ||
      await calculateAndRecordAdultEnergy(userId, {
        equationSex: 'female', ageYears: 22, heightCm: 165,
        weightKg: 60, activityLevel: 'light',
      }, { now: trialStartedAt });
    const draft = await createStagePlanDraft(userId, {
      stageLabel: '第一阶段：建立稳定饮食节奏',
      objective: '在学校日常场景中建立可以持续的三餐结构',
      durationDays: 14,
      energyCalculationId: calculation.calculationId,
      mealGuidance: [{
        mealType: 'general',
        guidance: '每餐按主食、蛋白质和蔬菜的结构搭配，并根据真实饱腹感小幅调整。',
      }],
      adjustmentRules: [
        '分量不够时优先根据饱腹感增加合适加餐',
        '当天有额外运动时结合实际活动调整当日饮食',
      ],
    }, { now: trialStartedAt });
    activePlan = await markOfficialPlanDelivered(userId, draft.planId, { deliveredAt: trialStartedAt });
  }

  const serviceStatus = persona === 'long_term_plateau' ? 'subscribed' : 'trial_active';
  userStore.setServiceStatus(userId, {
    status: serviceStatus,
    trialStartedAt,
    trialEndsAt: new Date(new Date(trialStartedAt).getTime() + 14 * DAY_MS).toISOString(),
    renewalReminderAt: new Date(new Date(trialStartedAt).getTime() + 13 * DAY_MS).toISOString(),
    officialPlanId: activePlan.planId,
  }, { reason: 'developer_fixture_ready', now: now.toISOString() });
  return activePlan;
}

function getPresentedAdminToken(req) {
  const authorization = req.get('authorization');
  if (typeof authorization === 'string') {
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch?.[1]) return bearerMatch[1].trim();
  }
  return typeof req.query?.token === 'string' ? req.query.token : null;
}

function adminTokensMatch(presentedToken, configuredToken) {
  if (typeof presentedToken !== 'string' || typeof configuredToken !== 'string') return false;
  const presentedBuffer = Buffer.from(presentedToken, 'utf8');
  const configuredBuffer = Buffer.from(configuredToken, 'utf8');
  if (presentedBuffer.length !== configuredBuffer.length) return false;
  return crypto.timingSafeEqual(presentedBuffer, configuredBuffer);
}

router.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();

  const configuredToken = process.env.DEBUG_ADMIN_TOKEN;
  if (!configuredToken) return res.status(404).json({ error: '接口不存在' });

  const presentedToken = getPresentedAdminToken(req);
  if (!presentedToken) return res.status(404).json({ error: '接口不存在' });
  if (!adminTokensMatch(presentedToken, configuredToken)) {
    return res.status(401).json({ error: '未授权' });
  }
  return next();
});

router.get('/users', (req, res) => {
  res.json({ users: userStore.listUserSummaries({ limit: 200 }) });
});

router.get('/snapshot', async (req, res) => {
  const { deviceId, userId } = req.query;
  let resolvedUserId = userId;
  if (!resolvedUserId && deviceId) {
    validateDeviceId(deviceId);
    resolvedUserId = await resolveAnonymousUser(deviceId, { store: userStore });
  }
  if (!resolvedUserId) return res.status(400).json({ error: '需要deviceId或userId' });
  const snapshot = userStore.getUserDataSnapshot(resolvedUserId);
  const userSettings = userStore.getUserSettings(resolvedUserId);
  const timezone = userSettings?.timezone || DEFAULT_TIMEZONE;
  return res.json({
    ...snapshot,
    userSettings,
    temporalContext: formatTemporalContext(new Date().toISOString(), timezone),
    timeline: await buildLongTermTimeline(resolvedUserId, { timezone }),
  });
});

router.post('/test-persona', express.json(), async (req, res) => {
  const { persona, deviceId, greetingUserId } = req.body || {};
  if (!TEST_PERSONAS.has(persona)) {
    return res.status(400).json({ error: '测试通道不正确' });
  }
  validateDeviceId(deviceId);
  const resolvedUserId = await resolveAnonymousUser(deviceId, { store: userStore });
  const now = new Date();
  const current = userStore.getServiceStatus(resolvedUserId);

  // 新联系人需要看到首次隐私说明；其他三种通道模拟已经来过的用户，
  // 因此预先建立独立的问候身份，让首页显示“欢迎回来”。
  if (persona !== 'new_contact') userStore.recordActivity(greetingUserId);

  const longTermPersonas = new Set([
    'long_term', 'long_term_day2', 'long_term_day8', 'long_term_plateau',
  ]);
  if (longTermPersonas.has(persona)) {
    const daysAgo = {
      long_term: 0, long_term_day2: 1, long_term_day8: 7, long_term_plateau: 29,
    }[persona];
    const trialStartedAt = atDaysAgo(now, daysAgo);
    userStore.setServiceStatus(resolvedUserId, {
      status: persona === 'long_term_plateau' ? 'subscribed' : 'trial_active',
      trialStartedAt,
      trialEndsAt: new Date(new Date(trialStartedAt).getTime() + 14 * DAY_MS).toISOString(),
      renewalReminderAt: new Date(new Date(trialStartedAt).getTime() + 13 * DAY_MS).toISOString(),
      officialPlanId: 'developer-test-plan',
    }, { reason: 'developer_persona_selected', now: now.toISOString() });

    await ensureLongTermFixture(resolvedUserId, { persona, now, trialStartedAt });

    if (persona === 'long_term_day8') {
      [6, 5, 3, 1].forEach((daysBack) => seedEvent(
        resolvedUserId, 'meal', atDaysAgo(now, daysBack),
        { summary: `开发者测试：第${8 - daysBack}天饮食已记录` },
        `developer-day8-meal:${daysBack}`,
      ));
    }
    if (persona === 'long_term_plateau') {
      [[28, 60], [21, 59.9], [14, 60.1], [7, 60], [0, 60]].forEach(([daysBack, weightKg]) =>
        seedEvent(
          resolvedUserId, 'body_measurement', atDaysAgo(now, daysBack),
          { summary: `开发者测试：标准化体重${weightKg}公斤`, weightKg },
          `developer-plateau-weight:${daysBack}`,
        ));
    }
  } else if (current?.status && current.status !== 'free') {
    userStore.setServiceStatus(resolvedUserId, { status: 'free' }, {
      reason: 'developer_persona_selected',
      now: now.toISOString(),
    });
  }

  const descriptions = {
    new_contact: '全新身份：会从隐私说明和首次了解开始。',
    free: '免费用户：保留基础档案和历史建议，不做长期跟踪调整。',
    long_term: '长期用户：模拟14天体验期内，可记录长期事件并读取长期上下文。',
    long_term_day2: '长期用户1：方案第2天，应询问昨天的饱腹感、肠胃和分量，不问体重。',
    long_term_day8: '长期用户2：方案第8天，应进行第一次周复盘，并邀请标准化称重。',
    long_term_plateau: '长期用户3：已有超过3周体重记录，模拟可能平台期的温和核查。',
  };
  return res.json({
    persona,
    userId: resolvedUserId,
    serviceStatus: userStore.getServiceStatus(resolvedUserId)?.status || 'free',
    description: descriptions[persona],
    timeline: await buildLongTermTimeline(resolvedUserId),
  });
});

module.exports = router;

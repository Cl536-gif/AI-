const express = require('express');
const chatService = require('../services/chatService');
const { resolveAnonymousUser, validateDeviceId } = require('../services/identityService');
const { buildLongTermTimeline } = require('../services/longTermTimelineService');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;
const MAX_USER_ID_LENGTH = 100;

function validateUserId(userId) {
  if (typeof userId !== 'string' || !userId.trim()) {
    return '用户标识（userId）不能为空';
  }
  if (userId.length > MAX_USER_ID_LENGTH) {
    return '用户标识格式不正确';
  }
  return null;
}

router.post('/greeting', async (req, res, next) => {
  const { userId, deviceId, testPersona } = req.body || {};

  const userIdError = validateUserId(userId);
  if (userIdError) {
    return res.status(400).json({ error: userIdError });
  }
  const allowedTestPersonas = new Set([
    'new_contact', 'free', 'long_term',
    'long_term_day2', 'long_term_day8', 'long_term_plateau',
  ]);
  if (testPersona !== undefined &&
      (process.env.NODE_ENV === 'production' || !allowedTestPersonas.has(testPersona))) {
    return res.status(400).json({ error: 'testPersona 格式不正确' });
  }

  try {
    let longTermTimeline = null;
    if (deviceId) {
      validateDeviceId(deviceId);
      const anonymousUserId = await resolveAnonymousUser(deviceId);
      longTermTimeline = await buildLongTermTimeline(anonymousUserId);
    }
    const result = await chatService.getGreeting({
      userId,
      forceReturning: Boolean(testPersona && testPersona !== 'new_contact'),
      longTermTimeline,
    });
    res.json({
      reply: result.reply,
      replies: result.replies || [result.reply],
      sessionId: result.sessionId,
      nextRoute: result.nextRoute || null,
      privacyOnboardingPending: Boolean(result.privacyOnboardingPending),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { message, sessionId, userId } = req.body || {};

  const userIdError = validateUserId(userId);
  if (userIdError) {
    return res.status(400).json({ error: userIdError });
  }
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: '消息内容过长' });
  }
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId 格式不正确' });
  }

  try {
    const result = await chatService.sendChatMessage({
      userId,
      message: message.trim(),
      sessionId,
    });
    res.json({
      reply: result.reply,
      replies: result.replies || [result.reply],
      sessionId: result.sessionId,
      nextRoute: result.nextRoute || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

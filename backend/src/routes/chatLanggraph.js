const express = require('express');
const {
  FAULT_HEADER,
  HOLD_HEADER,
  TOKEN_HEADER,
  assertHttpCanaryRequest,
  resolveHttpCanaryFaultControls,
  resolveHttpCanaryInstanceFingerprint,
} = require('../langgraph/httpCanaryBoundary');
const { validateDeviceId } = require('../services/identityService');
const {
  checkpointerPolicy,
  processLangGraphConversation,
  sanitizeUserVisibleReply,
  formatLongReplyForReadability,
  stripLongTermMetaJustification,
} = require('../services/langgraphConversationService');

const router = express.Router();
const MAX_MESSAGE_LENGTH = 2000;
const ALLOWED_TEST_PERSONAS = new Set([
  'new_contact', 'free', 'long_term',
  'long_term_day2', 'long_term_day8', 'long_term_plateau',
]);

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
  if (testPersona !== undefined &&
      (process.env.NODE_ENV === 'production' || !ALLOWED_TEST_PERSONAS.has(testPersona))) {
    return res.status(400).json({ error: 'testPersona 格式不正确' });
  }
  if (deviceId !== undefined) {
    try {
      validateDeviceId(deviceId);
    } catch (error) {
      return res.status(400).json({ error: error.message });
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

  try {
    const response = await processLangGraphConversation({
      message,
      threadId,
      deviceId,
      introAlreadyShown,
      privacyOnboarding,
      testPersona,
      httpCanaryControls,
      httpCanaryInstanceFingerprint,
    });
    return res.json(response);
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    return next(error);
  }
});

module.exports = router;
module.exports.sanitizeUserVisibleReply = sanitizeUserVisibleReply;
module.exports.formatLongReplyForReadability = formatLongReplyForReadability;
module.exports.stripLongTermMetaJustification = stripLongTermMetaJustification;

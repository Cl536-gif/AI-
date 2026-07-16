const express = require('express');
const chatService = require('../services/chatService');

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
  const { userId } = req.body || {};

  const userIdError = validateUserId(userId);
  if (userIdError) {
    return res.status(400).json({ error: userIdError });
  }

  try {
    const result = await chatService.getGreeting({ userId });
    res.json({ reply: result.reply, sessionId: result.sessionId });
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
  if (sessionId !== undefined && typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId 格式不正确' });
  }

  try {
    const result = await chatService.sendChatMessage({
      userId,
      message: message.trim(),
      sessionId,
    });
    res.json({ reply: result.reply, sessionId: result.sessionId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

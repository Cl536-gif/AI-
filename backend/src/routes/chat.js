const express = require('express');
const { sendMessage } = require('../services/bailianClient');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;

router.post('/', async (req, res, next) => {
  const { message, sessionId } = req.body || {};

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
    const result = await sendMessage({ message: message.trim(), sessionId });
    res.json({ reply: result.reply, sessionId: result.sessionId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const express = require('express');
const localChatService = require('../services/localChatService');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;

/**
 * 独立的本地知识库问答链路，仅供开发者自己对比测试用：
 * 本地向量检索 diet + body-composition 知识库 -> 拼提示词 -> 调用百炼通用模型接口。
 * 跟 /api/chat（百炼 App 自带知识库）完全没有交集，互不影响。
 */
router.post('/', async (req, res, next) => {
  const { message } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: '消息内容过长' });
  }

  try {
    const result = await localChatService.sendLocalChatMessage({ message: message.trim() });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

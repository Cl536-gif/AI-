const express = require('express');
const localChatService = require('../services/localChatService');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_TURNS = 40;

function validateHistory(history) {
  if (history === undefined) return null;
  if (!Array.isArray(history)) return '对话记录（history）格式不正确';
  if (history.length > MAX_HISTORY_TURNS) return '对话记录过长';

  for (const turn of history) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) {
      return '对话记录里有一条角色（role）不正确';
    }
    if (typeof turn.content !== 'string' || !turn.content.trim()) {
      return '对话记录里有一条内容为空';
    }
  }
  return null;
}

/**
 * 独立的本地知识库问答链路，仅供开发者自己对比测试用：
 * 本地向量检索 diet + body-composition 知识库 -> 拼提示词 -> 调用百炼通用模型接口。
 * 跟 /api/chat（百炼 App 自带知识库）完全没有交集，互不影响。
 *
 * history 可选：之前几轮对话记录 [{role:'user'|'assistant', content}, ...]，
 * 支持多轮连续对话；不传就是单轮问答。
 */
router.post('/', async (req, res, next) => {
  const { message, history } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: '消息内容过长' });
  }

  const historyError = validateHistory(history);
  if (historyError) {
    return res.status(400).json({ error: historyError });
  }

  try {
    const result = await localChatService.sendLocalChatMessage({ message: message.trim(), history });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

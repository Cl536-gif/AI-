// LangGraph 版本的对话链路：跟 /api/chat（百炼App）、/api/chat-local
// （本地知识库+纯提示词）完全独立，互不影响。核心差异是这条链路用
// 显式的状态机（六项信息各自 {value, confirmed}）管理采集流程，不再
// 依赖模型自己从对话历史里"回忆"当前进度——用来解决场景值前后矛盾、
// 完整信息被无视重新采集、改口未被识别这三个纯提示词架构下反复出现
// 的状态一致性问题。
//
// 服务端用 MemorySaver（内存版 checkpointer）按 threadId 维护每个会话
// 的状态，客户端只需要带上 threadId（第一次不传会自动生成，返回值里
// 带回去，后续轮次必须带上同一个才能延续对话），不需要像 /api/chat-local
// 那样每轮把完整历史传回来。
//
// 注意：MemorySaver 是内存存储，服务重启后所有会话状态会丢失，仅供
// 对比测试用，不是生产级持久化方案。
const express = require('express');
const crypto = require('crypto');
const { MemorySaver } = require('@langchain/langgraph');
const { workflow } = require('../langgraph/graph');
const { sanitize: sanitizeEnglish } = require('../services/contentSafety');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;

const checkpointer = new MemorySaver();
const graphWithMemory = workflow.compile({ checkpointer });

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
    .replace(/\bAI\b/g, '智能秘书');
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

router.post('/', async (req, res, next) => {
  const { message, threadId } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: '消息内容过长' });
  }
  if (threadId !== undefined && typeof threadId !== 'string') {
    return res.status(400).json({ error: 'threadId 格式不正确' });
  }

  const resolvedThreadId = threadId && threadId.trim() ? threadId.trim() : crypto.randomUUID();
  const config = { configurable: { thread_id: resolvedThreadId } };

  try {
    const result = await graphWithMemory.invoke(
      { messages: [{ role: 'human', content: message.trim() }] },
      config
    );

    const lastHumanIndex = result.messages.map((item) => getMessageRole(item)).lastIndexOf('human');
    const replies = result.messages
      .slice(lastHumanIndex + 1)
      .filter((item) => getMessageRole(item) !== 'human' && item.content)
      .map((item) => sanitizeUserVisibleReply(item.content));
    const reply = replies[replies.length - 1] || '';

    res.json({
      reply,
      replies,
      threadId: resolvedThreadId,
      slots: result.slots,
      cafeteriaMode: result.slots?.cafeteriaMode?.value || null,
      isComplete: result.isComplete,
      // isComplete 现在只代表"六项信息问完"，不代表方案已经生成——
      // 六项问完之后还要先经过 askServiceChoice 这一步，plan 是否真的
      // 已经生成，看 retrieved 是否非空（只有 generatePlan 才会填这项）
      // 更准确；serviceTier/pushSchedule 供前端/测试脚本观察这个新分岔
      // 的状态。
      serviceTier: result.serviceTier,
      pushSchedule: result.pushSchedule,
      bodyOnboardingStatus: result.bodyOnboardingStatus,
      bodyProfile: result.bodyProfile || {},
      cycleOnboardingStatus: result.cycleOnboardingStatus,
      menstrualProfile: result.menstrualProfile,
      retrieved: result.retrieved || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.sanitizeUserVisibleReply = sanitizeUserVisibleReply;
module.exports.formatLongReplyForReadability = formatLongReplyForReadability;

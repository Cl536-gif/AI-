const config = require('../config');

const REQUEST_TIMEOUT_MS = 30000;

/**
 * 转发一条用户消息到阿里云百炼应用完成接口，并返回 AI 回复。
 * sessionId 由百炼自身维护多轮上下文：首次调用不传，之后把上次返回的
 * sessionId 原样带上即可实现连续对话。
 */
async function sendMessage({ message, sessionId }) {
  const { apiKey, appId, baseUrl } = config.bailian;

  if (!apiKey || !appId) {
    throw new Error('缺少百炼 API Key 或应用 ID，请检查后端 .env 配置');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/${appId}/completion`;

  const input = { prompt: message };
  if (sessionId) {
    input.session_id = sessionId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('调用百炼接口超时');
    }
    throw new Error(`调用百炼接口失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = data?.message || data?.code || response.statusText;
    throw new Error(`调用百炼接口失败: ${detail}`);
  }

  if (!data || !data.output || typeof data.output.text !== 'string') {
    throw new Error('百炼接口返回格式异常');
  }

  return {
    reply: data.output.text,
    sessionId: data.output.session_id || sessionId || null,
    requestId: data.request_id,
  };
}

module.exports = { sendMessage };

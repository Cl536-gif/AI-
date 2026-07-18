const config = require('../config');

const REQUEST_TIMEOUT_MS = 30000;

/**
 * 调用阿里云百炼"通用模型对话接口"（OpenAI 兼容模式，比如 qwen-plus），
 * 跟 bailianClient.js 调用的那个绑定了知识库的百炼 App 是两条完全独立的路径：
 * 这里只是纯粹的模型问答，本地知识库检索结果需要自己拼进 prompt 里传进来。
 */
async function chat(prompt) {
  const { apiKey, genericBaseUrl, genericModel } = config.bailian;

  if (!apiKey) {
    throw new Error('缺少 BAILIAN_API_KEY，请检查后端 .env 配置');
  }

  const url = `${genericBaseUrl.replace(/\/$/, '')}/chat/completions`;

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
      body: JSON.stringify({
        model: genericModel,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('调用百炼通用模型接口超时');
    }
    throw new Error(`调用百炼通用模型接口失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = data?.error?.message || response.statusText;
    throw new Error(`调用百炼通用模型接口失败: HTTP ${response.status} ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('百炼通用模型接口返回内容为空');
  }

  return content;
}

module.exports = { chat };

require('dotenv').config();

const API_KEY = process.env.BAILIAN_API_KEY || '';
const BASE_URL = process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.BAILIAN_MODEL || 'qwen-plus';
const REQUEST_TIMEOUT_MS = 30000;

/**
 * 调用阿里云百炼通用模型接口（跟 backend/、pubmed-tool 里各自那份是同样的调用方式，
 * 但这是独立的第三份 —— 三个项目互相独立，各自有自己的 .env，不共享代码/配置）。
 */
async function chat(prompt) {
  if (!API_KEY) {
    throw new Error('缺少 BAILIAN_API_KEY，请检查 local-kb-tool/.env 配置');
  }

  const url = `${BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('调用百炼通用模型接口超时');
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
  if (!content) throw new Error('百炼通用模型接口返回内容为空');
  return content;
}

module.exports = { chat };

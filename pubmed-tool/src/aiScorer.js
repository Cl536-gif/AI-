const config = require('./config');

const RISK_FLAGS = ['涉及具体剂量/药物', '局部减脂类争议话题', '极端饮食方法', '特定病理人群'];

function buildPrompt(article) {
  return `你是一个医学文献筛选助手，帮内容团队判断一篇 PubMed 文献是否适合作为"女大学生饮食/体重体脂管理"产品的知识库参考依据。

标题：${article.title}
摘要：${article.abstract}

请完成两件事：
1. 相关性打分：1-5 的整数，5 表示跟"女大学生饮食/体重体脂管理"这个产品方向高度贴合，1 表示基本不相关
2. 风险标记：从下面这个列表里选出所有适用的（一个都不适用就是空数组），不要自己发明新的标记：
   - "涉及具体剂量/药物"：文献涉及药物、补充剂、兴奋剂类物质的具体摄入剂量
   - "局部减脂类争议话题"：涉及"是否存在局部减脂"这一有争议的话题
   - "极端饮食方法"：涉及断食、极低热量等可能不适合作为通用建议的方法
   - "特定病理人群"：研究对象为特定疾病患者（如糖尿病、PCOS 等），结论不适合泛化到普通用户

只输出下面这样的 JSON，不要输出任何其他文字、不要用 markdown 代码块包裹：
{"score": 数字, "riskFlags": ["标记1", "标记2"]}`;
}

function parseScoreResponse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`返回内容里没有找到 JSON: ${text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(match[0]);
  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new Error(`score 字段不是 1-5 的数字: ${JSON.stringify(parsed.score)}`);
  }

  const riskFlags = Array.isArray(parsed.riskFlags)
    ? parsed.riskFlags.filter((flag) => RISK_FLAGS.includes(flag))
    : [];

  return { score, riskFlags };
}

/** 调用阿里云百炼通用模型接口，给单篇文献打分 */
async function scoreArticle(article) {
  if (!config.bailianApiKey) {
    throw new Error('缺少 BAILIAN_API_KEY，请检查 .env 配置');
  }

  const url = `${config.bailianBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.bailianApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.bailianModel,
      messages: [{ role: 'user', content: buildPrompt(article) }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`AI 打分接口请求失败: HTTP ${response.status} ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('AI 打分接口返回内容为空');
  }

  return parseScoreResponse(content);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 依次给一批文献打分。单篇打分失败不影响其他篇——失败的那篇 aiScore 为 null、
 * riskFlags 为空数组，仍然会正常出现在候选清单里，只是没有分数（人工可以照常判断）。
 */
async function scoreArticles(articles, { onProgress } = {}) {
  const results = [];

  for (let i = 0; i < articles.length; i += 1) {
    const article = articles[i];
    try {
      const { score, riskFlags } = await scoreArticle(article);
      results.push({ ...article, aiScore: score, riskFlags });
    } catch (err) {
      console.warn(`  [AI 打分失败] PMID ${article.pmid}: ${err.message}`);
      results.push({ ...article, aiScore: null, riskFlags: [] });
    }

    if (onProgress) onProgress(i + 1, articles.length);
    if (i < articles.length - 1) {
      await sleep(config.aiScorerDelayMs);
    }
  }

  return results;
}

module.exports = { RISK_FLAGS, buildPrompt, parseScoreResponse, scoreArticle, scoreArticles };

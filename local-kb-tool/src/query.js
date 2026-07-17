require('dotenv').config();
const path = require('path');
const { embedQuery } = require('./embedder');
const { createStore, queryTopK } = require('./vectorStore');
const { keywordOverlapScore } = require('./keywordScore');

const INDEX_DIR = process.env.KB_INDEX_DIR || path.join(__dirname, '..', 'data', 'index');
const TOP_K = Number(process.env.KB_TOP_K) || 5;
const CANDIDATE_POOL = Math.max(TOP_K * 3, 15);

// 混合检索：语义相似度 + 关键词重合度按权重加权后重新排序，
// 弥补纯语义向量偶尔会把"话题相关但答非所问"的长片段排到精确匹配前面的问题。
// 设成 0 就等于关掉关键词加权，退回纯语义排序。
const KEYWORD_WEIGHT = process.env.KB_KEYWORD_WEIGHT !== undefined
  ? Number(process.env.KB_KEYWORD_WEIGHT)
  : 0.35;

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('请提供查询问题，例如: npm run query -- "需要注册吗"');
    process.exitCode = 1;
    return;
  }

  const index = createStore(INDEX_DIR);
  if (!(await index.isIndexCreated())) {
    console.error(`索引不存在，请先运行 npm run build-index（目录: ${INDEX_DIR}）`);
    process.exitCode = 1;
    return;
  }

  const vector = await embedQuery(question);
  const candidates = await queryTopK(index, vector, CANDIDATE_POOL);

  const results = candidates
    .map((r) => {
      const keywordScore = keywordOverlapScore(question, r.text);
      const hybridScore = (1 - KEYWORD_WEIGHT) * r.score + KEYWORD_WEIGHT * keywordScore;
      return { ...r, semanticScore: r.score, keywordScore, hybridScore };
    })
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, TOP_K);

  console.log(`\n问题: ${question}\n`);
  if (results.length === 0) {
    console.log('没有检索到相关片段。');
    return;
  }

  results.forEach((r, i) => {
    console.log(
      `--- 结果 ${i + 1}（综合 ${r.hybridScore.toFixed(4)} = 语义 ${r.semanticScore.toFixed(4)} + 关键词 ${r.keywordScore.toFixed(4)}，来源: ${r.source}） ---`
    );
    console.log(r.text);
    console.log();
  });
}

main().catch((err) => {
  console.error('查询失败:', err);
  process.exitCode = 1;
});

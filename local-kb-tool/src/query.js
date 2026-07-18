require('dotenv').config();
const { embedQuery } = require('./embedder');
const { createStore, queryTopK } = require('./vectorStore');
const { keywordOverlapScore } = require('./keywordScore');
const { parseKbArg, resolveKbPaths } = require('./kbPaths');

const TOP_K = Number(process.env.KB_TOP_K) || 5;
const CANDIDATE_POOL = Math.max(TOP_K * 3, 15);

// 混合检索：语义相似度 + 关键词重合度按权重加权后重新排序，
// 弥补纯语义向量偶尔会把"话题相关但答非所问"的长片段排到精确匹配前面的问题。
// 设成 0 就等于关掉关键词加权，退回纯语义排序。
const KEYWORD_WEIGHT = process.env.KB_KEYWORD_WEIGHT !== undefined
  ? Number(process.env.KB_KEYWORD_WEIGHT)
  : 0.35;

/**
 * 对单个知识库做一次混合检索，返回按 hybridScore 排好序的 top-K 片段。
 * 抽成独立函数是为了让 backend 那条独立的本地知识库问答链路也能直接复用，
 * 不用再维护第二份检索逻辑。
 */
async function retrieve(kbName, question) {
  const { indexDir: INDEX_DIR } = resolveKbPaths(kbName);

  const index = createStore(INDEX_DIR);
  if (!(await index.isIndexCreated())) {
    const err = new Error(`索引不存在（知识库: ${kbName || '默认'}），请先运行 npm run build-index${kbName ? ` -- --kb ${kbName}` : ''}（目录: ${INDEX_DIR}）`);
    err.code = 'KB_INDEX_NOT_FOUND';
    throw err;
  }

  const vector = await embedQuery(question);
  const candidates = await queryTopK(index, vector, CANDIDATE_POOL);

  return candidates
    .map((r) => {
      const keywordScore = keywordOverlapScore(question, r.text);
      const hybridScore = (1 - KEYWORD_WEIGHT) * r.score + KEYWORD_WEIGHT * keywordScore;
      return { ...r, semanticScore: r.score, keywordScore, hybridScore };
    })
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, TOP_K);
}

async function main() {
  const { kbName, rest } = parseKbArg(process.argv.slice(2));
  const question = rest.join(' ').trim();

  if (!question) {
    console.error('请提供查询问题，例如: npm run query -- "需要注册吗"（多知识库用 npm run query -- --kb posture "问题"）');
    process.exitCode = 1;
    return;
  }

  let results;
  try {
    results = await retrieve(kbName, question);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

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

if (require.main === module) {
  main().catch((err) => {
    console.error('查询失败:', err);
    process.exitCode = 1;
  });
}

module.exports = { retrieve };

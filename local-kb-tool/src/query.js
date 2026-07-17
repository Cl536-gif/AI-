require('dotenv').config();
const path = require('path');
const { embedQuery } = require('./embedder');
const { createStore, queryTopK } = require('./vectorStore');

const INDEX_DIR = process.env.KB_INDEX_DIR || path.join(__dirname, '..', 'data', 'index');
const TOP_K = Number(process.env.KB_TOP_K) || 5;

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
  const results = await queryTopK(index, vector, TOP_K);

  console.log(`\n问题: ${question}\n`);
  if (results.length === 0) {
    console.log('没有检索到相关片段。');
    return;
  }

  results.forEach((r, i) => {
    console.log(`--- 结果 ${i + 1}（相似度 ${r.score.toFixed(4)}，来源: ${r.source}） ---`);
    console.log(r.text);
    console.log();
  });
}

main().catch((err) => {
  console.error('查询失败:', err);
  process.exitCode = 1;
});

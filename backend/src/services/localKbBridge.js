const path = require('path');

// local-kb-tool 是一个独立项目，有自己的 .env（比如 KB_HF_ENDPOINT 镜像站配置）。
// backend 进程启动时的 cwd 是 backend/，dotenv 默认只会读到 backend/.env，
// 这里显式把 local-kb-tool/.env 也加载进来，且必须在 require 它的检索模块之前做，
// 否则 embedder.js 里读 KB_EMBEDDING_MODEL 等环境变量时就已经晚了。
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', 'local-kb-tool', '.env') });

const { retrieve } = require('../../../local-kb-tool/src/query');

/**
 * 依次查询多个本地知识库，每个库各取自己的 top-K，合并成一份带知识库来源标记的列表。
 * 单个知识库查询失败（比如索引还没建）不影响其他知识库，失败的会带上 error 字段。
 */
async function retrieveFromKbs(question, kbNames) {
  const perKb = await Promise.all(
    kbNames.map(async (kbName) => {
      try {
        const results = await retrieve(kbName, question);
        return { kbName, results };
      } catch (err) {
        return { kbName, results: [], error: err.message };
      }
    })
  );

  return perKb;
}

module.exports = { retrieveFromKbs };

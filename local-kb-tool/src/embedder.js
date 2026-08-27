const fs = require('fs');
const path = require('path');

const MODEL_NAME = process.env.KB_EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5';
const BUNDLED_MODEL_ROOT = path.join(__dirname, '..', 'models');
const BUNDLED_MODEL_DIR = path.join(BUNDLED_MODEL_ROOT, MODEL_NAME);

// BGE 系列模型官方建议：查询文本前面加这个指令前缀，检索效果会明显更好；
// 存文档片段时不需要加。换了非 BGE 模型可以把 KB_QUERY_INSTRUCTION 设成空字符串关掉。
const QUERY_INSTRUCTION =
  process.env.KB_QUERY_INSTRUCTION !== undefined
    ? process.env.KB_QUERY_INSTRUCTION
    : '为这个句子生成表示以用于检索相关文章：';

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');

      // Cloud runtimes must not depend on a first-request Hugging Face download.
      // When the compact model bundle exists, resolve it locally and fail closed
      // instead of silently attempting the network.
      if (fs.existsSync(BUNDLED_MODEL_DIR)) {
        env.localModelPath = `${BUNDLED_MODEL_ROOT}${path.sep}`;
        env.allowRemoteModels = false;
      } else if (process.env.KB_HF_ENDPOINT) {
        // huggingface.co 在国内经常连不上/超时，可以在 .env 里设置
        // KB_HF_ENDPOINT=https://hf-mirror.com 切换成镜像站，URL 结构完全兼容
        env.remoteHost = process.env.KB_HF_ENDPOINT;
      }
      return pipeline('feature-extraction', MODEL_NAME);
    })();
  }
  return extractorPromise;
}

async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/** 把一批文档片段转成向量（数组的数组），建索引时用 */
async function embedTexts(texts) {
  const vectors = [];
  for (const text of texts) {
    vectors.push(await embed(text));
  }
  return vectors;
}

/** 把一个查询问题转成向量，查询时用（会自动加检索指令前缀） */
async function embedQuery(text) {
  return embed(QUERY_INSTRUCTION + text);
}

module.exports = { embedTexts, embedQuery };

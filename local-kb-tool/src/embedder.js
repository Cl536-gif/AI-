const MODEL_NAME = process.env.KB_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      // huggingface.co 在国内经常连不上/超时，可以在 .env 里设置
      // KB_HF_ENDPOINT=https://hf-mirror.com 切换成镜像站，URL 结构完全兼容
      if (process.env.KB_HF_ENDPOINT) {
        env.remoteHost = process.env.KB_HF_ENDPOINT;
      }
      return pipeline('feature-extraction', MODEL_NAME);
    })();
  }
  return extractorPromise;
}

/** 把一批文本转成向量（数组的数组），首次调用会下载/加载本地 embedding 模型 */
async function embedTexts(texts) {
  const extractor = await getExtractor();
  const vectors = [];
  for (const text of texts) {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    vectors.push(Array.from(output.data));
  }
  return vectors;
}

module.exports = { embedTexts };

const MODEL_NAME = process.env.KB_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
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

const { LocalIndex } = require('vectra');

function createStore(indexDir) {
  return new LocalIndex(indexDir);
}

/** 确保索引存在；recreate=true 时先删除旧索引再重建（重新 build-index 用） */
async function ensureIndexReady(index, { recreate = false } = {}) {
  const exists = await index.isIndexCreated();
  if (exists && recreate) {
    await index.deleteIndex();
  }
  if (!exists || recreate) {
    await index.createIndex();
  }
}

async function addChunk(index, { vector, text, source, chunkIndex }) {
  await index.insertItem({ vector, metadata: { text, source, chunkIndex } });
}

async function queryTopK(index, vector, topK) {
  const results = await index.queryItems(vector, '', topK);
  return results.map((r) => ({
    score: r.score,
    text: r.item.metadata.text,
    source: r.item.metadata.source,
    chunkIndex: r.item.metadata.chunkIndex,
  }));
}

module.exports = { createStore, ensureIndexReady, addChunk, queryTopK };

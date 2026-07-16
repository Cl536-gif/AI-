require('dotenv').config();
const path = require('path');
const { readDocxFiles } = require('./docReader');
const { chunkText } = require('./chunker');
const { embedTexts } = require('./embedder');
const { createStore, ensureIndexReady, addChunk } = require('./vectorStore');

const KB_DOCS_DIR = process.env.KB_DOCS_DIR || path.join(__dirname, '..', 'kb-docs');
const INDEX_DIR = process.env.KB_INDEX_DIR || path.join(__dirname, '..', 'data', 'index');
const MAX_CHUNK_CHARS = Number(process.env.KB_CHUNK_CHARS) || 500;
const EMBED_BATCH_SIZE = 16;

async function main() {
  console.log(`读取文档目录: ${KB_DOCS_DIR}`);
  const docs = await readDocxFiles(KB_DOCS_DIR);
  if (docs.length === 0) {
    console.error(`目录里没有找到 .docx 文件: ${KB_DOCS_DIR}`);
    process.exitCode = 1;
    return;
  }
  console.log(`共读取到 ${docs.length} 份文档`);

  const allChunks = [];
  for (const doc of docs) {
    const chunks = chunkText(doc.text, { maxChunkChars: MAX_CHUNK_CHARS });
    chunks.forEach((text, chunkIndex) => {
      allChunks.push({ text, source: doc.fileName, chunkIndex });
    });
    console.log(`  - ${doc.fileName}: ${chunks.length} 个片段`);
  }
  console.log(
    `共切分出 ${allChunks.length} 个片段，开始生成向量` +
      '（首次运行会下载本地 embedding 模型，需要联网，之后完全离线）...'
  );

  const index = createStore(INDEX_DIR);
  await ensureIndexReady(index, { recreate: true });

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedTexts(batch.map((c) => c.text));
    for (let j = 0; j < batch.length; j += 1) {
      await addChunk(index, { ...batch[j], vector: vectors[j] });
    }
    console.log(`  已处理 ${Math.min(i + EMBED_BATCH_SIZE, allChunks.length)}/${allChunks.length}`);
  }

  console.log(`索引构建完成，共 ${allChunks.length} 个片段，存储在: ${INDEX_DIR}`);
}

main().catch((err) => {
  console.error('建索引失败:', err);
  process.exitCode = 1;
});

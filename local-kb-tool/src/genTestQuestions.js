require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createStore } = require('./vectorStore');
const { resolveKbPaths } = require('./kbPaths');
const bailianClient = require('./bailianClient');

const KB_NAMES = process.env.EVAL_KB_NAMES
  ? process.env.EVAL_KB_NAMES.split(',').map((s) => s.trim()).filter(Boolean)
  : ['diet', 'body-composition'];

const GEN_DELAY_MS = Number(process.env.EVAL_GEN_DELAY_MS) || 400;
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'test-questions.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(chunkText) {
  return `你是一个用户体验研究员，需要模拟真实用户会怎么口语化地提问。

下面是一份知识库里的一段内容：
"""
${chunkText}
"""

请生成 3-5 个用户可能会问的、能被这段内容回答的真实问题。要求：
1. 不要照抄原文的句子结构和用词，要用口语化、日常聊天式的问法（可以简短、可以不完整、可以带点模糊的说法）
2. 每个问题都应该是完全独立的一句话，模拟真实用户会怎么打字提问
3. 只输出一个 JSON 数组，形如 ["问题1", "问题2", "问题3"]，不要输出任何其他文字，不要用 markdown 代码块包裹`;
}

function parseQuestions(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`返回内容里没有找到 JSON 数组: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || parsed.some((q) => typeof q !== 'string')) {
    throw new Error('返回内容不是字符串数组');
  }
  return parsed.map((q) => q.trim()).filter(Boolean);
}

/**
 * "知识点"在这里的操作化定义是"索引里的每一个片段（chunk）"——建索引时
 * 已经按 FAQ 的 Q/A 边界、或者固定字符数切分过，每个片段本身就是一个相对
 * 独立的知识点，直接拿来逐个生成测试问法，不用再额外去理解文档结构。
 */
async function genForKb(kbName) {
  const { indexDir } = resolveKbPaths(kbName);
  const index = createStore(indexDir);

  if (!(await index.isIndexCreated())) {
    console.warn(`跳过知识库 "${kbName}"：索引不存在（${indexDir}），请先运行 npm run build-index -- --kb ${kbName}`);
    return [];
  }

  const items = await index.listItems();
  console.log(`知识库 "${kbName}"：共 ${items.length} 个片段，开始生成测试问法...`);

  const entries = [];
  for (let i = 0; i < items.length; i += 1) {
    const { text, source, chunkIndex } = items[i].metadata;
    try {
      const raw = await bailianClient.chat(buildPrompt(text));
      const questions = parseQuestions(raw);
      entries.push({ kbName, source, chunkIndex, chunkPreview: text.slice(0, 80), questions });
    } catch (err) {
      console.warn(`  [生成失败] ${source} #${chunkIndex}: ${err.message}`);
    }

    if ((i + 1) % 5 === 0 || i === items.length - 1) {
      console.log(`  已处理 ${i + 1}/${items.length}`);
    }
    if (i < items.length - 1) await sleep(GEN_DELAY_MS);
  }

  return entries;
}

async function main() {
  const allEntries = [];
  for (const kbName of KB_NAMES) {
    const entries = await genForKb(kbName);
    allEntries.push(...entries);
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allEntries, null, 2), 'utf-8');

  const totalQuestions = allEntries.reduce((sum, e) => sum + e.questions.length, 0);
  console.log(`\n生成完成：${allEntries.length} 个知识点，共 ${totalQuestions} 个测试问题，已保存到 ${OUTPUT_FILE}`);
  console.log('接下来运行 npm run eval-retrieval 跑检索测试。');
}

main().catch((err) => {
  console.error('生成测试题库失败:', err);
  process.exitCode = 1;
});

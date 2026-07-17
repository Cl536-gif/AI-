require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('./config');
const pubmedClient = require('./pubmedClient');
const { prefilterArticles } = require('./prefilter');
const { scoreArticles } = require('./aiScorer');
const { renderCandidateMarkdown } = require('./candidateList');
const { loadProcessedPmids } = require('./processedStore');

/**
 * 应急恢复工具：如果某份候选清单文件意外丢失/被覆盖，用 data/processed-pmids.json
 * 里记录的 PMID 列表重新抓取 + 预筛选 + AI 打分，重建一份等效的候选清单。
 * 注意：AI 打分可能因为模型的非确定性跟原来略有出入，但文献内容和数量应该一致。
 */
async function main() {
  const processedPmids = Array.from(loadProcessedPmids());
  if (processedPmids.length === 0) {
    console.log('data/processed-pmids.json 里没有任何记录，没有可以重建的内容。');
    return;
  }

  console.log(`从 processed-pmids.json 里读到 ${processedPmids.length} 个 PMID，开始重新抓取...`);
  const articles = await pubmedClient.fetchArticles(processedPmids);
  console.log(`抓取完成，共 ${articles.length} 篇。`);

  const { kept, rejected } = prefilterArticles(articles);
  console.log(`预筛选：保留 ${kept.length} 篇，剔除 ${rejected.length} 篇。`);

  console.log(`AI 打分环节：开始处理 ${kept.length} 篇...`);
  const scored = await scoreArticles(kept, {
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) {
        console.log(`  已处理 ${done}/${total}`);
      }
    },
  });
  const sorted = [...scored].sort((a, b) => {
    if (a.aiScore === null && b.aiScore === null) return 0;
    if (a.aiScore === null) return 1;
    if (b.aiScore === null) return -1;
    return b.aiScore - a.aiScore;
  });

  const generatedAt = new Date().toISOString();
  const markdown = renderCandidateMarkdown({
    keywords: config.keywords,
    kept: sorted,
    rejected,
    generatedAt,
  });

  fs.mkdirSync(config.outputDir, { recursive: true });
  const timestamp = generatedAt.replace(/[:.]/g, '-');
  const filePath = path.join(config.outputDir, `rebuilt-${timestamp}.md`);
  fs.writeFileSync(filePath, markdown, 'utf-8');

  console.log(`\n重建完成，共 ${sorted.length} 篇候选文献，已生成: ${filePath}`);
}

main().catch((err) => {
  console.error('重建失败:', err);
  process.exitCode = 1;
});

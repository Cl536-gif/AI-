require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('./config');
const pubmedClient = require('./pubmedClient');
const { prefilterArticles } = require('./prefilter');
const { scoreArticles } = require('./aiScorer');
const { renderCandidateMarkdown } = require('./candidateList');
const { loadProcessedPmids, saveProcessedPmids } = require('./processedStore');

function parseDaysArg(argv) {
  const idx = argv.indexOf('--days');
  if (idx !== -1 && argv[idx + 1]) {
    const days = Number(argv[idx + 1]);
    if (Number.isFinite(days) && days > 0) return days;
  }
  return config.weeklyDays;
}

async function collectPmids(days) {
  const pmidSet = new Set();

  for (let i = 0; i < config.keywords.length; i += 1) {
    const keyword = config.keywords[i];
    process.stdout.write(`检索关键词: ${keyword}（最近 ${days} 天）... `);
    const pmids = await pubmedClient.searchPmids(keyword, { days });
    pmids.forEach((id) => pmidSet.add(id));
    console.log(`找到 ${pmids.length} 篇（累计去重后 ${pmidSet.size} 篇）`);

    if (i < config.keywords.length - 1) {
      await pubmedClient.sleep(pubmedClient.REQUEST_DELAY_MS);
    }
  }

  return Array.from(pmidSet);
}

// 分数高的排前面；AI 打分失败（null）的排最后，不影响其他文献的排序
function sortByAiScoreDesc(articles) {
  return [...articles].sort((a, b) => {
    if (a.aiScore === null && b.aiScore === null) return 0;
    if (a.aiScore === null) return 1;
    if (b.aiScore === null) return -1;
    return b.aiScore - a.aiScore;
  });
}

async function main() {
  const days = parseDaysArg(process.argv.slice(2));

  console.log(`每周增量更新 —— 检索最近 ${days} 天内的新文献`);
  console.log(`关键词列表（${config.keywords.length} 个）：`);
  config.keywords.forEach((k) => console.log(`  - ${k}`));
  console.log();

  const foundPmids = await collectPmids(days);
  console.log(`\n本次抓到 ${foundPmids.length} 篇（去重后）`);

  const processedPmids = loadProcessedPmids();
  const newPmids = foundPmids.filter((id) => !processedPmids.has(id));
  console.log(`去重后剩 ${newPmids.length} 篇新文献（已跳过 ${foundPmids.length - newPmids.length} 篇之前处理过的）`);

  if (newPmids.length === 0) {
    console.log('\n本次无新文献，结束运行，不生成候选清单，无需人工介入。');
    return;
  }

  console.log(`\n开始抓取新文献的标题/摘要...`);
  const articles = await pubmedClient.fetchArticles(newPmids);
  console.log(`抓取完成，共 ${articles.length} 篇。`);

  const { kept, rejected } = prefilterArticles(articles);
  console.log(`预筛选：保留 ${kept.length} 篇，剔除 ${rejected.length} 篇。`);

  console.log(`\nAI 打分环节：开始处理 ${kept.length} 篇...`);
  const scored = await scoreArticles(kept, {
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) {
        console.log(`  已处理 ${done}/${total}`);
      }
    },
  });
  const sorted = sortByAiScoreDesc(scored);
  const flaggedCount = sorted.filter((a) => a.riskFlags && a.riskFlags.length > 0).length;
  console.log(`AI 打分完成，其中 ${flaggedCount} 篇带风险标记，需要人工重点复核。`);

  const generatedAt = new Date().toISOString();
  const markdown = renderCandidateMarkdown({
    keywords: config.keywords,
    kept: sorted,
    rejected,
    generatedAt,
  });

  fs.mkdirSync(config.outputDir, { recursive: true });
  const fileName = `weekly-${generatedAt.slice(0, 10)}.md`;
  const filePath = path.join(config.outputDir, fileName);
  fs.writeFileSync(filePath, markdown, 'utf-8');

  // 不管保留还是剔除，这批 PMID 都已经评估过，下次不用再重复抓取
  const allSeenPmids = [...kept.map((a) => a.pmid), ...rejected.map((a) => a.pmid)];
  allSeenPmids.forEach((id) => processedPmids.add(id));
  saveProcessedPmids(processedPmids);

  console.log(`\n最终候选清单包含 ${sorted.length} 篇，已生成: ${filePath}`);
  console.log('打开这份文件，重点看带 ⚠️ 标记的条目，把想保留的文献前面的 [ ] 改成 [x]，改完运行：');
  console.log(`  npm run collect-kept -- ${filePath}`);
}

main().catch((err) => {
  console.error('每周增量更新失败:', err);
  process.exitCode = 1;
});

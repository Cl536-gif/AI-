const fs = require('fs');
const path = require('path');
const config = require('./config');
const pubmedClient = require('./pubmedClient');
const { prefilterArticles } = require('./prefilter');
const { renderCandidateMarkdown } = require('./candidateList');

async function collectPmids() {
  const pmidSet = new Set();

  for (let i = 0; i < config.keywords.length; i += 1) {
    const keyword = config.keywords[i];
    process.stdout.write(`检索关键词: ${keyword} ... `);
    const pmids = await pubmedClient.searchPmids(keyword);
    pmids.forEach((id) => pmidSet.add(id));
    console.log(`找到 ${pmids.length} 篇（累计去重后 ${pmidSet.size} 篇）`);

    if (i < config.keywords.length - 1) {
      await pubmedClient.sleep(pubmedClient.REQUEST_DELAY_MS);
    }
  }

  return Array.from(pmidSet);
}

async function main() {
  console.log(`关键词列表（${config.keywords.length} 个）：`);
  config.keywords.forEach((k) => console.log(`  - ${k}`));
  console.log();

  const pmids = await collectPmids();
  if (pmids.length === 0) {
    console.log('没有检索到任何文献，结束。');
    return;
  }

  console.log(`\n共 ${pmids.length} 篇待抓取，开始抓取标题/摘要...`);
  const articles = await pubmedClient.fetchArticles(pmids);
  console.log(`抓取完成，共 ${articles.length} 篇。`);

  const { kept, rejected } = prefilterArticles(articles);
  console.log(`预筛选：保留 ${kept.length} 篇，剔除 ${rejected.length} 篇。`);

  const generatedAt = new Date().toISOString();
  const markdown = renderCandidateMarkdown({ keywords: config.keywords, kept, rejected, generatedAt });

  fs.mkdirSync(config.outputDir, { recursive: true });
  const fileName = `candidates-${generatedAt.slice(0, 10)}.md`;
  const filePath = path.join(config.outputDir, fileName);
  fs.writeFileSync(filePath, markdown, 'utf-8');

  console.log(`\n候选清单已生成: ${filePath}`);
  console.log('打开这份文件，把想保留的文献前面的 [ ] 改成 [x]，改完运行：');
  console.log(`  npm run collect-kept -- ${filePath}`);
}

main().catch((err) => {
  console.error('抓取失败:', err);
  process.exitCode = 1;
});

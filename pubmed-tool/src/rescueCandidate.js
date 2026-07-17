require('dotenv').config();
const fs = require('fs');
const pubmedClient = require('./pubmedClient');

function buildRescueBlock(article, index) {
  const authors = (article.authors || []).join(', ') || '（未知）';
  const abstract = (article.abstract || '（无摘要）').trim();

  return [
    `## ${index}. ${article.title || '（无标题）'}`,
    '',
    '- [ ] 保留',
    `- PMID: ${article.pmid}`,
    `- 期刊：${article.journal || '（未知）'}`,
    `- 年份：${article.year || '（未知）'}`,
    `- 作者：${authors}`,
    `- 链接：${article.url}`,
    '- 备注：人工手动加回（原本被预筛选规则误判排除，详见 false-positive-log.md）',
    '',
    '摘要：',
    abstract,
    '',
    '---',
    '',
    '',
  ].join('\n');
}

async function main() {
  const [filePath, pmid] = process.argv.slice(2);

  if (!filePath || !pmid) {
    console.error('用法: npm run rescue-candidate -- <候选清单文件路径> <PMID>');
    console.error('用于把被预筛选规则误判排除的文献，手动加回某一份候选清单里。');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`抓取 PMID ${pmid} 的信息...`);
  const [article] = await pubmedClient.fetchArticles([pmid]);
  if (!article) {
    console.error(`没有从 PubMed 抓到 PMID ${pmid} 对应的文献，请确认 PMID 是否正确。`);
    process.exitCode = 1;
    return;
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(`PMID: ${pmid}`)) {
    console.log(`PMID ${pmid} 已经在这份清单里了，不用重复添加。`);
    return;
  }

  const existingNumbers = [...content.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
  const nextIndex = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;

  const block = buildRescueBlock(article, nextIndex);

  // 插入点：低相关性分组标题之前，否则预筛选剔除清单标题之前，否则文件末尾
  const lowRelevanceIdx = content.indexOf('## 低相关性文献');
  const rejectedIdx = content.indexOf('## 预筛选剔除清单');
  const insertAt = lowRelevanceIdx !== -1 ? lowRelevanceIdx : (rejectedIdx !== -1 ? rejectedIdx : content.length);

  content = content.slice(0, insertAt) + block + content.slice(insertAt);
  content = content.replace(/候选文献数：(\d+)(?=（|$)/, (_, n) => `候选文献数：${Number(n) + 1}`);

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`已把 PMID ${pmid}（编号 ${nextIndex}）加回候选清单: ${filePath}`);
  console.log('别忘了同步在 false-positive-log.md 里记一条这次误判的原因。');
}

main().catch((err) => {
  console.error('加回候选清单失败:', err);
  process.exitCode = 1;
});

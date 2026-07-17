function formatRiskFlags(riskFlags) {
  if (!riskFlags || riskFlags.length === 0) return '';
  return riskFlags.join('、');
}

function formatArticleBlock(article, index) {
  const authors = (article.authors || []).join(', ') || '（未知）';
  const abstract = (article.abstract || '（无摘要）').trim();
  const hasAiScore = article.aiScore !== undefined && article.aiScore !== null;
  const hasRiskFlags = article.riskFlags && article.riskFlags.length > 0;

  const lines = [`## ${index}. ${article.title || '（无标题）'}`, ''];

  if (hasRiskFlags) {
    lines.push(`⚠️ 需要人工重点复核（${formatRiskFlags(article.riskFlags)}）`, '');
  }

  lines.push(
    '- [ ] 保留',
    `- PMID: ${article.pmid}`,
    `- 期刊：${article.journal || '（未知）'}`,
    `- 年份：${article.year || '（未知）'}`,
    `- 作者：${authors}`,
    `- 链接：${article.url}`
  );

  if (hasAiScore) {
    lines.push(`- AI 相关性打分：${article.aiScore}/5`);
  }
  if (hasRiskFlags) {
    lines.push(`- 风险标记：${formatRiskFlags(article.riskFlags)}`);
  }

  lines.push('', '摘要：', abstract, '', '---', '');

  return lines.join('\n');
}

function formatRejectedLine(article) {
  return `- [${article.pmid}] ${article.title || '（无标题）'} —— ${article.filterReasons.join('；')}`;
}

/** 生成候选清单 Markdown 文本；kept 里每条带 [ ] 复选框供人工勾选 */
function renderCandidateMarkdown({ keywords, kept, rejected, generatedAt }) {
  const lines = [
    '# PubMed 候选文献清单',
    '',
    `生成时间：${generatedAt}`,
    `关键词：${keywords.join(' | ')}`,
    `候选文献数：${kept.length}（预筛选剔除 ${rejected.length} 篇，详见文末）`,
    '',
    '使用方法：审阅每篇的标题和摘要，把想保留的那一项的 `[ ]` 改成 `[x]`，' +
      '改完保存后运行 `npm run collect-kept -- <这份文件的路径>` 生成"已保留"清单。',
    '',
    '---',
    '',
  ];

  kept.forEach((article, i) => {
    lines.push(formatArticleBlock(article, i + 1));
  });

  if (rejected.length > 0) {
    lines.push('## 预筛选剔除清单（仅供核查筛选规则是否合理，不需要处理）');
    lines.push('');
    rejected.forEach((article) => lines.push(formatRejectedLine(article)));
    lines.push('');
  }

  return lines.join('\n');
}

const BLOCK_SPLIT_REGEX = /\n---\n/;
const CHECKBOX_REGEX = /-\s*\[([ xX])\]\s*保留/;
const FIELD_REGEXES = {
  pmid: /- PMID:\s*(\S+)/,
  journal: /- 期刊：(.*)/,
  year: /- 年份：(\S+)/,
  authors: /- 作者：(.*)/,
  url: /- 链接：(\S+)/,
  aiScore: /- AI 相关性打分：(\S+)\/5/,
  riskFlags: /- 风险标记：(.*)/,
  title: /^##\s*\d+\.\s*(.*)$/m,
};

function parseArticleBlock(block) {
  const checkboxMatch = block.match(CHECKBOX_REGEX);
  if (!checkboxMatch) return null;

  const kept = checkboxMatch[1].toLowerCase() === 'x';
  const abstractMatch = block.match(/摘要：\n([\s\S]*)$/);

  const get = (key) => {
    const match = block.match(FIELD_REGEXES[key]);
    return match ? match[1].trim() : '';
  };

  return {
    kept,
    pmid: get('pmid'),
    title: get('title'),
    journal: get('journal'),
    year: get('year'),
    authors: get('authors'),
    url: get('url'),
    aiScore: get('aiScore'),
    riskFlags: get('riskFlags'),
    abstract: abstractMatch ? abstractMatch[1].trim() : '',
  };
}

/** 解析已经人工勾选过的候选清单 Markdown，返回被勾选为"保留"的文献 */
function parseReviewedMarkdown(markdown) {
  const blocks = markdown.split(BLOCK_SPLIT_REGEX);
  return blocks
    .map(parseArticleBlock)
    .filter((entry) => entry && entry.kept);
}

function renderKeptMarkdown(keptArticles, generatedAt) {
  const lines = [
    '# 已保留文献清单',
    '',
    `生成时间：${generatedAt}`,
    `共 ${keptArticles.length} 篇`,
    '',
    '下一步：人工提炼核心结论、结合产品语境改写，整理进知识库文档时标注来源（作者/期刊/年份/PMID）。',
    '',
    '---',
    '',
  ];

  keptArticles.forEach((article, i) => {
    lines.push(`## ${i + 1}. ${article.title}`);
    lines.push('');
    lines.push(`- PMID: ${article.pmid}`);
    lines.push(`- 期刊：${article.journal}`);
    lines.push(`- 年份：${article.year}`);
    lines.push(`- 作者：${article.authors}`);
    lines.push(`- 链接：${article.url}`);
    if (article.aiScore) {
      lines.push(`- AI 相关性打分：${article.aiScore}/5`);
    }
    if (article.riskFlags) {
      lines.push(`- 风险标记：${article.riskFlags}`);
    }
    lines.push('');
    lines.push('摘要：');
    lines.push(article.abstract);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n');
}

module.exports = { renderCandidateMarkdown, parseReviewedMarkdown, renderKeptMarkdown };

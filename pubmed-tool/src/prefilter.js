const config = require('./config');

const ANIMAL_STUDY_REGEX = /\b(mice|mouse|rat|rats|rodent|rodents|murine|animal model|zebrafish)\b/i;
const CLINICAL_NONDIET_REGEX = /\b(surgery|surgical|pharmacological|pharmacology|drug therapy|chemotherapy)\b/i;

/**
 * 对单篇文献做预筛选，返回 { keep: boolean, reasons: string[] }。
 * reasons 记录被过滤掉的具体原因，用于生成清单时展示、方便人工复核筛选逻辑本身有没有问题。
 */
function evaluateArticle(article) {
  const reasons = [];
  const abstract = article.abstract || '';
  const combinedText = `${article.title || ''} ${abstract}`;

  if (ANIMAL_STUDY_REGEX.test(combinedText)) {
    reasons.push('包含动物实验关键词（mice/rat/rodent 等）');
  }

  if (article.year && article.year < config.minYear) {
    reasons.push(`发表年份过早（${article.year} < ${config.minYear}）`);
  } else if (!article.year) {
    reasons.push('未能识别发表年份');
  }

  if (abstract.trim().length < config.minAbstractLength) {
    reasons.push(`摘要过短（${abstract.trim().length} 字符 < ${config.minAbstractLength}）`);
  }

  if (CLINICAL_NONDIET_REGEX.test(combinedText)) {
    reasons.push('疑似纯药物/临床手术类研究（surgery/pharmacological 等关键词）');
  }

  return { keep: reasons.length === 0, reasons };
}

/** 对一批文献做预筛选，返回 { kept, rejected }，rejected 附带过滤原因 */
function prefilterArticles(articles) {
  const kept = [];
  const rejected = [];

  for (const article of articles) {
    const { keep, reasons } = evaluateArticle(article);
    if (keep) {
      kept.push(article);
    } else {
      rejected.push({ ...article, filterReasons: reasons });
    }
  }

  return { kept, rejected };
}

module.exports = { evaluateArticle, prefilterArticles };

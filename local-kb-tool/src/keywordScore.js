function toBigrams(text) {
  const clean = text.replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) {
    grams.add(clean.slice(i, i + 2));
  }
  return grams;
}

/**
 * 简单的字符 bigram 重合度打分（0~1），不依赖任何中文分词库。
 * 衡量 query 里的字符对有多大比例真实出现在 text 里，
 * 用来给包含精确关键词（比如"注册"）的片段一个加分，弥补纯语义向量
 * 有时候会被话题相关但答非所问的长片段抢排名的问题。
 */
function keywordOverlapScore(query, text) {
  const queryGrams = toBigrams(query);
  if (queryGrams.size === 0) return 0;

  const textGrams = toBigrams(text);
  let hit = 0;
  for (const gram of queryGrams) {
    if (textGrams.has(gram)) hit += 1;
  }
  return hit / queryGrams.size;
}

module.exports = { keywordOverlapScore };

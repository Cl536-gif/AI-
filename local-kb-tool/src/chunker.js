function splitIntoParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// "Q：xxx" 开头的段落是FAQ类文档的问答边界；圈码数字（①②③...）开头的
// 段落是"逐项列出维度/步骤"类结构化列表的边界（比如"信息采集清单"按
// ①-⑥列出六个维度）；"一、二、三、..."这类中文数字顿号，是文档顶层
// 章节标题的边界（比如产品介绍文档按"一、我们是谁""二、我们能为你
// 做什么""三、适合谁使用""四、产品特色"分节）。三种都表示"这里必须
// 另起一个独立的知识点"：单独开始一个片段，后续段落并入同一片段直到
// 下一个边界为止，不受 maxChunkChars 限制拆开——避免相邻但主题不同的
// 章节（比如"我们是谁"这类宽泛的产品介绍 跟 "产品特色"）被按字符数
// 硬凑到一起、内容太宽泛而在检索时跟很多不相关的查询都能扯上关系。
const STRUCTURAL_BOUNDARY_REGEX = /^(Q[:：]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]、)/;

/**
 * 按段落切分文本，尽量把相邻段落合并到接近 maxChunkChars 的片段里。
 * 遇到结构化边界段落时单独起一个片段（见 STRUCTURAL_BOUNDARY_REGEX）。
 *
 * minLeadChars：文档开头的标题、"归类标签：xxx"这类前言信息量很低，
 * 却因为"专属饮食秘书"这类每份文档都会出现的高频词，在检索时容易跟
 * 真正的正文抢排名——开头这一块攒够 minLeadChars 字符之前，不允许
 * 单独切出去当一个独立片段，强制并入第一个有实质内容的片段。
 */
function chunkText(text, { maxChunkChars = 500, minLeadChars = 200 } = {}) {
  const paragraphs = splitIntoParagraphs(text);
  const chunks = [];
  let current = '';
  let inBlock = false;
  // 前言只允许并入"下一个"结构化边界一次——避免开头连续好几个圈码
  // 数字项目（比如①②③紧挨着出现、单项本身很短）在 minLeadChars 攒够
  // 之前被反复并到一起，把预算、忌口这类本该分开的相邻项目又混回一块。
  let leadMerged = false;

  function leadTooShort() {
    return chunks.length === 0 && !leadMerged && current.trim().length < minLeadChars;
  }

  function flush() {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = '';
    inBlock = false;
  }

  for (const paragraph of paragraphs) {
    if (STRUCTURAL_BOUNDARY_REGEX.test(paragraph)) {
      if (leadTooShort()) {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
        inBlock = true;
        leadMerged = true;
        continue;
      }
      flush();
      current = paragraph;
      inBlock = true;
      continue;
    }

    if (paragraph.length > maxChunkChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += maxChunkChars) {
        chunks.push(paragraph.slice(i, i + maxChunkChars).trim());
      }
      continue;
    }

    if (inBlock) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }

    if (current && current.length + paragraph.length + 2 > maxChunkChars && !leadTooShort()) {
      flush();
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();

  return chunks;
}

module.exports = { chunkText };

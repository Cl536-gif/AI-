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
  // 前言只允许"跳过空壳边界"（比如FAQ手册标题后紧跟的"一、上手与使用类"
  // 这类没有自己内容、下一段就是另一个边界的子标题）——一旦某个结构化
  // 边界后面真的跟了一段实质内容，紧接着的下一个边界就必须正常独立
  // 成块，不能再往下吞并，避免①②③④这种各自有实质内容的相邻项目被
  // 连续合并回一块。判断放在"要不要合并这次边界"之前，而不是合并完
  // 之后才生效——否则每次都会多吞并一个本该独立的边界。
  let boundarySegmentHasContent = false;

  function canAbsorbBoundary() {
    return chunks.length === 0 && !boundarySegmentHasContent && current.trim().length < minLeadChars;
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
      if (canAbsorbBoundary()) {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
        inBlock = true;
        boundarySegmentHasContent = false;
        continue;
      }
      flush();
      current = paragraph;
      inBlock = true;
      boundarySegmentHasContent = false;
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
      // 结构化边界内部依然要守住 maxChunkChars 兜底——像"信息采集清单"
      // 这类天然很短的①-⑥单项、FAQ的Q/A对不会撞到这个上限，但像学术
      // 引用堆叠、内部没有更细边界的大节，不能因为"在边界内"就无限
      // 增长到远超预期的大小，那样会变成新的"内容跨度太大"问题。
      if (current.length + paragraph.length + 2 > maxChunkChars) {
        flush();
        current = paragraph;
        inBlock = true;
        boundarySegmentHasContent = true;
        continue;
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      boundarySegmentHasContent = true;
      continue;
    }

    if (current && current.length + paragraph.length + 2 > maxChunkChars && !canAbsorbBoundary()) {
      flush();
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();

  return chunks;
}

module.exports = { chunkText };

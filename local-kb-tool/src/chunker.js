function splitIntoParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// "Q：xxx" 开头的段落视为一个问答片段的起点
const QA_BOUNDARY_REGEX = /^Q[:：]/;

/**
 * 按段落切分文本，尽量把相邻段落合并到接近 maxChunkChars 的片段里。
 * 遇到 "Q：" 开头的段落（FAQ 类文档常见格式）时，单独开始一个问答片段，
 * 后续段落（通常是对应的 "A：" 答案）并入同一片段，直到下一个 "Q：" 为止，
 * 不会跟其他问答对合并、也不受 maxChunkChars 限制拆开，保证一问一答的完整性。
 */
function chunkText(text, { maxChunkChars = 500 } = {}) {
  const paragraphs = splitIntoParagraphs(text);
  const chunks = [];
  let current = '';
  let inQaBlock = false;

  function flush() {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = '';
    inQaBlock = false;
  }

  for (const paragraph of paragraphs) {
    if (QA_BOUNDARY_REGEX.test(paragraph)) {
      flush();
      current = paragraph;
      inQaBlock = true;
      continue;
    }

    if (paragraph.length > maxChunkChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += maxChunkChars) {
        chunks.push(paragraph.slice(i, i + maxChunkChars).trim());
      }
      continue;
    }

    if (inQaBlock) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }

    if (current && current.length + paragraph.length + 2 > maxChunkChars) {
      flush();
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();

  return chunks;
}

module.exports = { chunkText };

function splitIntoParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 按段落切分文本，尽量把相邻段落合并到接近 maxChunkChars 的片段里 */
function chunkText(text, { maxChunkChars = 500 } = {}) {
  const paragraphs = splitIntoParagraphs(text);
  const chunks = [];
  let current = '';

  function flush() {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = '';
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChunkChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += maxChunkChars) {
        chunks.push(paragraph.slice(i, i + maxChunkChars).trim());
      }
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

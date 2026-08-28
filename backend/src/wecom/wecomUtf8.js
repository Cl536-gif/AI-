function utf8ByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function truncateUtf8(value, maxBytes = 2048) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('UTF-8截断上限必须是正整数');
  }
  const text = String(value || '');
  if (utf8ByteLength(text) <= maxBytes) return text;
  const suffix = '…';
  const budget = Math.max(0, maxBytes - utf8ByteLength(suffix));
  let used = 0;
  let output = '';
  for (const character of text) {
    const bytes = utf8ByteLength(character);
    if (used + bytes > budget) break;
    output += character;
    used += bytes;
  }
  return output + suffix;
}

module.exports = { truncateUtf8, utf8ByteLength };

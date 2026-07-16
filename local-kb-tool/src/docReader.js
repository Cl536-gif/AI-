const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');

/** 读取指定目录下的所有 .docx 文件，返回 [{ fileName, text }] */
async function readDocxFiles(dir) {
  const fileNames = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.docx') && !name.startsWith('~$'));

  const docs = [];
  for (const fileName of fileNames) {
    const filePath = path.join(dir, fileName);
    const { value: text } = await mammoth.extractRawText({ path: filePath });
    docs.push({ fileName, text });
  }
  return docs;
}

module.exports = { readDocxFiles };

const fs = require('fs');
const path = require('path');
const config = require('./config');

function getStorePath() {
  return path.resolve(config.processedStoreFile);
}

/** 读取已处理过的 PMID 集合；文件不存在时视为空集合 */
function loadProcessedPmids() {
  const filePath = getStorePath();
  if (!fs.existsSync(filePath)) {
    return new Set();
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return new Set(data.processed_pmids || []);
}

/** 把一批 PMID 合并进已处理记录并写回文件 */
function saveProcessedPmids(pmidSet) {
  const filePath = getStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sorted = Array.from(pmidSet).sort();
  fs.writeFileSync(filePath, JSON.stringify({ processed_pmids: sorted }, null, 2), 'utf-8');
}

module.exports = { loadProcessedPmids, saveProcessedPmids };

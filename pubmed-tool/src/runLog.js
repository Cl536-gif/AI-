const fs = require('fs');
const path = require('path');

const LOG_DIR = 'logs';
const LOG_FILE = path.join(LOG_DIR, 'weekly-update.log');

/** 往运行日志追加一行带时间戳的记录，不管是手动运行还是 cron 触发都会写 */
function appendRunLog(message) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`, 'utf-8');
}

module.exports = { appendRunLog, LOG_FILE };

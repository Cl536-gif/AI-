const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    last_active_at TEXT NOT NULL
  )
`);

const selectStmt = db.prepare('SELECT last_active_at FROM users WHERE user_id = ?');
const upsertStmt = db.prepare(`
  INSERT INTO users (user_id, last_active_at) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET last_active_at = excluded.last_active_at
`);

/**
 * 记录一次用户活跃，返回本次更新前的上一次活跃时间（没有记录则为 null）。
 * 调用方可以据此算出"距离上次聊天过了多久"。
 */
function recordActivity(userId) {
  const now = new Date().toISOString();
  const existing = selectStmt.get(userId);
  upsertStmt.run(userId, now);
  return { previousActiveAt: existing ? existing.last_active_at : null, now };
}

module.exports = { recordActivity };

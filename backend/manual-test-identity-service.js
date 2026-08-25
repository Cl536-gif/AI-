const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createUserStore } = require('./src/services/userStore');
const { resolveAnonymousUser, validateDeviceId } = require('./src/services/identityService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-identity-'));
  const dbPath = path.join(tempDir, 'test.db');
  const store = createUserStore({ dbPath });
  const firstDevice = '11111111-1111-4111-8111-111111111111';
  const secondDevice = '22222222-2222-4222-8222-222222222222';

  const firstUser = await resolveAnonymousUser(firstDevice, { store, now: '2026-08-05T10:00:00+08:00' });
  const sameUser = await resolveAnonymousUser(firstDevice.toUpperCase(), { store, now: '2026-08-05T11:00:00+08:00' });
  const secondUser = await resolveAnonymousUser(secondDevice, { store, now: '2026-08-05T12:00:00+08:00' });

  assert(firstUser.startsWith('anon:'), '匿名身份没有使用anon命名空间');
  assert(firstUser === sameUser, '同一设备没有稳定解析为同一匿名用户');
  assert(firstUser !== secondUser, '不同设备被错误映射为同一匿名用户');

  let invalidRejected = false;
  try {
    validateDeviceId('acct:forged-user');
  } catch (err) {
    invalidRejected = /deviceId格式不正确/.test(err.message);
  }
  assert(invalidRejected, '客户端伪造的正式账号身份没有被拒绝');

  store.close();
  const inspectionDb = new DatabaseSync(dbPath, { readOnly: true });
  const storedIdentity = inspectionDb.prepare(`
    SELECT external_subject_hash FROM user_identities WHERE user_id = ?
  `).get(firstUser);
  assert(storedIdentity.external_subject_hash !== firstDevice, '数据库保存了原始deviceId');
  assert(storedIdentity.external_subject_hash.length === 64, 'deviceId摘要长度不正确');
  inspectionDb.close();

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 同一设备稳定映射为同一匿名用户');
  console.log('✅ 不同设备身份相互隔离');
  console.log('✅ 客户端不能用deviceId伪造正式账号身份');
  console.log('✅ 数据库只保存deviceId摘要');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

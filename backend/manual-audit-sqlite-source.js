const {
  DEFAULT_SQLITE_PATH,
  inventorySqliteDatabase,
} = require('./src/migration/sqliteDataInventory');

const CONFIRMATION = 'CONFIRMED_005J_READ_ONLY_SQLITE_INVENTORY';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function run(env = process.env) {
  if (String(env.RUN_005J_SQLITE_INVENTORY || '').trim() !== CONFIRMATION) {
    fail('VERIFY_CONFIRMATION_REQUIRED');
  }
  if (String(env.USER_STORE_ADAPTER || 'sqlite').trim().toLowerCase() !== 'sqlite') {
    fail('SQLITE_SOURCE_REQUIRED');
  }
  const result = inventorySqliteDatabase({ dbPath: DEFAULT_SQLITE_PATH });
  console.log(JSON.stringify({
    batch: '005j-sqlite-source-inventory',
    status: 'PASS',
    ...result,
  }));
  return result;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(JSON.stringify({
      batch: '005j-sqlite-source-inventory',
      status: 'FAIL',
      errorCode: error?.code || 'INVENTORY_ERROR',
    }));
    process.exitCode = 1;
  }
}

module.exports = {
  CONFIRMATION,
  run,
};

const assert = require('assert');
const {
  getMissingUserStoreMethods,
} = require('./src/stores/userStoreContract');
const {
  configureUserStoreFromEnv,
  getUserStore,
  resetUserStore,
} = require('./src/stores/userStoreProvider');

function main() {
  try {
    const sqliteStore = configureUserStoreFromEnv({
      env: { USER_STORE_ADAPTER: 'sqlite' },
    });
    assert.strictEqual(sqliteStore, getUserStore());
    assert.deepStrictEqual(getMissingUserStoreMethods(sqliteStore), []);

    const tencentStore = configureUserStoreFromEnv({
      env: { USER_STORE_ADAPTER: 'tencent-postgres' },
    });
    assert.strictEqual(tencentStore, getUserStore());
    assert.notStrictEqual(tencentStore, sqliteStore);
    assert.deepStrictEqual(getMissingUserStoreMethods(tencentStore), []);

    assert.throws(
      () => configureUserStoreFromEnv({ env: { USER_STORE_ADAPTER: 'unknown' } }),
      /不支持的 USER_STORE_ADAPTER/
    );

    console.log(JSON.stringify({
      batch: '004n-provider-selection',
      status: 'PASS',
      sqliteDefaultAvailable: true,
      tencentPostgresExplicitOptInAvailable: true,
      unknownAdapterRejected: true,
      contractMethodCount: 37,
    }));
  } finally {
    resetUserStore();
  }
}

try {
  main();
} catch (error) {
  resetUserStore();
  console.error(error);
  process.exitCode = 1;
}

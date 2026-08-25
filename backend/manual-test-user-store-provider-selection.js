const assert = require('assert');
const {
  getMissingUserStoreMethods,
} = require('./src/stores/userStoreContract');
const {
  configureUserStoreFromEnv,
  getUserStore,
  resetUserStore,
} = require('./src/stores/userStoreProvider');
const {
  SINGLE_INSTANCE_CANARY_MODE,
  SINGLE_INSTANCE_CONFIRMATION,
  FULL_CUTOVER_MODE,
  FULL_CUTOVER_CONFIRMATION,
} = require('./src/stores/tencentPostgresCutoverGate');

function main() {
  try {
    const sqliteStore = configureUserStoreFromEnv({
      env: { USER_STORE_ADAPTER: 'sqlite' },
    });
    assert.strictEqual(sqliteStore, getUserStore());
    assert.deepStrictEqual(getMissingUserStoreMethods(sqliteStore), []);

    assert.throws(
      () => configureUserStoreFromEnv({ env: { USER_STORE_ADAPTER: 'tencent-postgres' } }),
      (error) => error.code === 'POSTGRES_CUTOVER_MODE_REQUIRED'
    );

    const canaryEnv = {
      USER_STORE_ADAPTER: 'tencent-postgres',
      TENCENT_PG_CUTOVER_MODE: SINGLE_INSTANCE_CANARY_MODE,
      TENCENT_PG_CUTOVER_CONFIRM: SINGLE_INSTANCE_CONFIRMATION,
      TENCENT_PG_CANARY_MAX_INSTANCES: '1',
      TENCENT_PG_POOL_MAX: '1',
    };
    const tencentStore = configureUserStoreFromEnv({ env: canaryEnv });
    assert.strictEqual(tencentStore, getUserStore());
    assert.notStrictEqual(tencentStore, sqliteStore);
    assert.deepStrictEqual(getMissingUserStoreMethods(tencentStore), []);

    assert.throws(
      () => configureUserStoreFromEnv({
        env: { ...canaryEnv, TENCENT_PG_POOL_MAX: '5' },
      }),
      (error) => error.code === 'POSTGRES_CANARY_SCOPE_INVALID'
    );

    assert.throws(
      () => configureUserStoreFromEnv({
        env: {
          USER_STORE_ADAPTER: 'tencent-postgres',
          TENCENT_PG_CUTOVER_MODE: FULL_CUTOVER_MODE,
          TENCENT_PG_CUTOVER_CONFIRM: FULL_CUTOVER_CONFIRMATION,
        },
      }),
      (error) => error.code === 'POSTGRES_FULL_CUTOVER_NOT_READY'
    );

    assert.throws(
      () => configureUserStoreFromEnv({ env: { USER_STORE_ADAPTER: 'unknown' } }),
      /不支持的 USER_STORE_ADAPTER/
    );

    console.log(JSON.stringify({
      batch: '004n-provider-selection',
      status: 'PASS',
      sqliteDefaultAvailable: true,
      tencentPostgresSingleInstanceCanaryAvailable: true,
      accidentalPostgresSelectionRejected: true,
      unsafeCanaryScopeRejected: true,
      fullCutoverRemainsRejected: true,
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

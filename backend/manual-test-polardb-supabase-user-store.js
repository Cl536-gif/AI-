const assert = require('assert');
const {
  USER_STORE_METHODS,
  getMissingUserStoreMethods,
} = require('./src/stores/userStoreContract');
const {
  createSupabaseUserStore,
  createPolarDbSupabaseUserStoreFromEnv,
} = require('./src/stores/supabaseUserStore');
const {
  configureUserStoreFromEnv,
  getUserStore,
  resetUserStore,
} = require('./src/stores/userStoreProvider');

async function main() {
  const calls = [];
  const fakeClient = {
    async rpc(name, params) {
      calls.push({ name, params });
      return { data: { operation: params.p_operation, args: params.p_arguments.args }, error: null };
    },
  };
  const store = createSupabaseUserStore({ client: fakeClient, rpcName: 'test_dispatch' });
  assert.deepStrictEqual(getMissingUserStoreMethods(store), []);

  for (const methodName of USER_STORE_METHODS) {
    const result = await store[methodName]('user:test', { sample: true });
    assert.strictEqual(result.operation, methodName);
    assert.deepStrictEqual(result.args, ['user:test', { sample: true }]);
  }
  assert.strictEqual(calls.length, USER_STORE_METHODS.length);
  assert(calls.every((call) => call.name === 'test_dispatch'));

  const sqliteStore = configureUserStoreFromEnv({ env: { USER_STORE_ADAPTER: 'sqlite' } });
  assert.strictEqual(sqliteStore, getUserStore());
  assert.deepStrictEqual(getMissingUserStoreMethods(sqliteStore), []);

  assert.throws(
    () => configureUserStoreFromEnv({ env: { USER_STORE_ADAPTER: 'polardb-supabase' } }),
    /已停用的历史草稿/
  );
  const tencentStore = configureUserStoreFromEnv({
    env: { USER_STORE_ADAPTER: 'tencent-postgres' },
  });
  assert.strictEqual(tencentStore, getUserStore());
  assert.deepStrictEqual(getMissingUserStoreMethods(tencentStore), []);

  assert.throws(
    () => configureUserStoreFromEnv({ env: { USER_STORE_ADAPTER: 'unknown' } }),
    /不支持的 USER_STORE_ADAPTER/
  );

  await assert.rejects(
    createSupabaseUserStore({
      client: { async rpc() { return { data: null, error: { message: 'denied', code: '42501' } }; } },
    }).getProfile('user:test'),
    (error) => error.code === '42501' && /getProfile/.test(error.message)
  );
  assert.throws(
    () => createPolarDbSupabaseUserStoreFromEnv({ env: {} }),
    /POLARDB_SUPABASE_URL 和 POLARDB_SUPABASE_SERVICE_ROLE_KEY/
  );

  resetUserStore();
  console.log(`PolarDB PostgreSQL Supabase UserStore adapter passed (${USER_STORE_METHODS.length} RPC mappings).`);
  console.log('Provider selection passed (sqlite default + Tencent PostgreSQL explicit opt-in).');
  console.log('RPC error normalization passed.');
}

main().catch((error) => {
  resetUserStore();
  console.error(error);
  process.exitCode = 1;
});

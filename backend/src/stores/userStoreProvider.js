const defaultStore = require('../services/userStore');
const { assertUserStore } = require('./userStoreContract');

let activeStore = assertUserStore(defaultStore, { adapterName: 'SqliteUserStore' });

function getUserStore() {
  return activeStore;
}

function setUserStore(store, { adapterName = 'UserStore' } = {}) {
  activeStore = assertUserStore(store, { adapterName });
  return activeStore;
}

function resetUserStore() {
  activeStore = assertUserStore(defaultStore, { adapterName: 'SqliteUserStore' });
  return activeStore;
}

function configureUserStoreFromEnv({ env = process.env } = {}) {
  const adapter = String(env.USER_STORE_ADAPTER || 'sqlite').trim().toLowerCase();
  if (adapter === 'sqlite' || adapter === 'local') return resetUserStore();
  if (adapter === 'polardb-supabase' || adapter === 'polardb_supabase') {
    throw new Error(
      'USER_STORE_ADAPTER=polardb-supabase 是已停用的历史草稿，不能用于腾讯云MemFire'
    );
  }
  if (adapter === 'tencent-postgres' || adapter === 'tencent_postgres') {
    const { createTencentPostgresUserStore } = require('./tencentPostgresUserStore');
    return setUserStore(createTencentPostgresUserStore(), {
      adapterName: 'TencentPostgresUserStore',
    });
  }
  throw new Error(`不支持的 USER_STORE_ADAPTER：${adapter}`);
}

module.exports = {
  getUserStore,
  setUserStore,
  resetUserStore,
  configureUserStoreFromEnv,
};

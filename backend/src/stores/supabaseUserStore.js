const { assertUserStore, USER_STORE_METHODS } = require('./userStoreContract');

const DEFAULT_RPC_NAME = 'diet_user_store_execute';

function normalizeRpcError(error, operation) {
  const message = error?.message || String(error || '未知错误');
  const wrapped = new Error(`Supabase UserStore.${operation} 调用失败：${message}`);
  wrapped.code = error?.code || 'SUPABASE_USER_STORE_ERROR';
  wrapped.details = error?.details || null;
  wrapped.hint = error?.hint || null;
  wrapped.cause = error;
  return wrapped;
}

/**
 * Supabase-compatible adapter for the UserStore port.
 *
 * The adapter is intentionally database-vendor neutral. Production currently
 * targets Alibaba Cloud PolarDB PostgreSQL Supabase. Multi-table invariants
 * must be implemented atomically by a PostgreSQL RPC transaction boundary.
 * Node.js must not
 * emulate transactions with a sequence of independent HTTP requests.
 */
function createSupabaseUserStore({ client, rpcName = DEFAULT_RPC_NAME } = {}) {
  if (!client || typeof client.rpc !== 'function') {
    throw new TypeError('创建 SupabaseUserStore 需要支持 rpc() 的 Supabase 客户端');
  }

  async function execute(operation, args) {
    const { data, error } = await client.rpc(rpcName, {
      p_operation: operation,
      p_arguments: { args },
    });
    if (error) throw normalizeRpcError(error, operation);
    return data;
  }

  const store = {};
  for (const methodName of USER_STORE_METHODS) {
    store[methodName] = (...args) => execute(methodName, args);
  }

  store.close = async () => {};
  return assertUserStore(store, { adapterName: 'SupabaseUserStore' });
}

function loadCreateClient() {
  try {
    return require('@supabase/supabase-js').createClient;
  } catch (error) {
    const wrapped = new Error(
      '缺少 @supabase/supabase-js。启用 PolarDB PostgreSQL Supabase 前请先安装该依赖。'
    );
    wrapped.code = 'SUPABASE_SDK_MISSING';
    wrapped.cause = error;
    throw wrapped;
  }
}

function createPolarDbSupabaseUserStoreFromEnv({ env = process.env, createClient } = {}) {
  const url = String(env.POLARDB_SUPABASE_URL || '').trim();
  const serviceRoleKey = String(env.POLARDB_SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const rpcName = String(env.POLARDB_SUPABASE_USER_STORE_RPC || DEFAULT_RPC_NAME).trim();

  if (!url || !serviceRoleKey) {
    throw new Error(
      '启用 PolarDB PostgreSQL Supabase 需要配置 POLARDB_SUPABASE_URL 和 POLARDB_SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  const factory = createClient || loadCreateClient();
  const client = factory(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return createSupabaseUserStore({ client, rpcName });
}

module.exports = {
  DEFAULT_RPC_NAME,
  createSupabaseUserStore,
  createPolarDbSupabaseUserStoreFromEnv,
};

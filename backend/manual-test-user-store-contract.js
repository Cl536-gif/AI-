const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const {
  USER_STORE_METHODS,
  USER_STORE_ADMIN_METHODS,
  getMissingUserStoreMethods,
  getMissingUserStoreAdminMethods,
  assertUserStore,
  assertUserStoreAdmin,
} = require('./src/stores/userStoreContract');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-user-store-contract-'));
const store = createUserStore({ dbPath: path.join(tempDir, 'contract.sqlite') });

try {
  assert.deepStrictEqual(getMissingUserStoreMethods(store), []);
  assert.strictEqual(assertUserStore(store, { adapterName: 'SqliteUserStore' }), store);
  assert.deepStrictEqual(getMissingUserStoreAdminMethods(store), []);
  assert.strictEqual(
    assertUserStoreAdmin(store, { adapterName: 'SqliteUserStoreAdmin' }),
    store
  );
  assert.throws(
    () => assertUserStore({}, { adapterName: 'BrokenStore' }),
    /BrokenStore 缺少 UserStore 方法/
  );
  assert(USER_STORE_METHODS.includes('getProfile'));
  assert(USER_STORE_METHODS.includes('appendEvent'));
  assert(USER_STORE_METHODS.includes('getUserDataSnapshot'));
  assert(!USER_STORE_METHODS.includes('listUserSummaries'));
  assert.deepStrictEqual(USER_STORE_ADMIN_METHODS, ['listUserSummaries']);
  console.log(
    `UserStore contract passed (${USER_STORE_METHODS.length} production methods + ` +
    `${USER_STORE_ADMIN_METHODS.length} admin method).`
  );
} finally {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

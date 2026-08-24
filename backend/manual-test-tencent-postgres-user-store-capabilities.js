const assert = require('assert');
const { USER_STORE_METHODS } = require('./src/stores/userStoreContract');
const {
  DATABASE_READY_METHODS,
  SCHEMA_REQUIRED_METHODS,
  CONTRACT_CHANGE_REQUIRED_METHODS,
  METHOD_CAPABILITIES,
  assertCompleteCapabilityInventory,
  isTencentPostgresCutoverReady,
} = require('./src/stores/tencentPostgresUserStoreCapabilities');

const inventory = assertCompleteCapabilityInventory();

assert.strictEqual(USER_STORE_METHODS.length, 38);
assert.strictEqual(inventory.length, USER_STORE_METHODS.length);
assert.strictEqual(DATABASE_READY_METHODS.length, 27);
assert.strictEqual(SCHEMA_REQUIRED_METHODS.length, 9);
assert.strictEqual(CONTRACT_CHANGE_REQUIRED_METHODS.length, 2);
assert.strictEqual(new Set(Object.keys(METHOD_CAPABILITIES)).size, USER_STORE_METHODS.length);
assert.deepStrictEqual(
  [
    ...DATABASE_READY_METHODS,
    ...SCHEMA_REQUIRED_METHODS,
    ...CONTRACT_CHANGE_REQUIRED_METHODS,
  ].sort(),
  [...USER_STORE_METHODS].sort()
);
assert.strictEqual(isTencentPostgresCutoverReady(), false);

console.log(JSON.stringify({
  batch: '004a',
  status: 'PASS',
  contractMethodCount: USER_STORE_METHODS.length,
  databaseReadyMethodCount: DATABASE_READY_METHODS.length,
  schemaRequiredMethodCount: SCHEMA_REQUIRED_METHODS.length,
  contractChangeRequiredMethodCount: CONTRACT_CHANGE_REQUIRED_METHODS.length,
  cutoverReady: false,
}));

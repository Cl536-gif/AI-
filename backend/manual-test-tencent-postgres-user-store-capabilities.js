const assert = require('assert');
const { USER_STORE_METHODS } = require('./src/stores/userStoreContract');
const {
  IMPLEMENTED_AND_VERIFIED_METHODS,
  DATABASE_READY_METHODS,
  SCHEMA_REQUIRED_METHODS,
  CONTRACT_CHANGE_REQUIRED_METHODS,
  METHOD_CAPABILITIES,
  assertCompleteCapabilityInventory,
  isTencentPostgresCutoverReady,
} = require('./src/stores/tencentPostgresUserStoreCapabilities');

const inventory = assertCompleteCapabilityInventory();

assert.strictEqual(USER_STORE_METHODS.length, 37);
assert.strictEqual(inventory.length, USER_STORE_METHODS.length);
assert.strictEqual(DATABASE_READY_METHODS.length, 37);
assert.strictEqual(IMPLEMENTED_AND_VERIFIED_METHODS.length, 37);
assert.strictEqual(SCHEMA_REQUIRED_METHODS.length, 0);
assert.strictEqual(CONTRACT_CHANGE_REQUIRED_METHODS.length, 0);
assert.strictEqual(new Set(Object.keys(METHOD_CAPABILITIES)).size, USER_STORE_METHODS.length);
assert.deepStrictEqual(
  [
    ...IMPLEMENTED_AND_VERIFIED_METHODS,
    ...SCHEMA_REQUIRED_METHODS,
    ...CONTRACT_CHANGE_REQUIRED_METHODS,
  ].sort(),
  [...USER_STORE_METHODS].sort()
);
assert(inventory.every(({ status }) => status === 'implemented_and_verified'));
assert.strictEqual(isTencentPostgresCutoverReady(), true);

console.log(JSON.stringify({
  batch: '004a',
  status: 'PASS',
  contractMethodCount: USER_STORE_METHODS.length,
  implementedAndVerifiedMethodCount: IMPLEMENTED_AND_VERIFIED_METHODS.length,
  schemaRequiredMethodCount: SCHEMA_REQUIRED_METHODS.length,
  contractChangeRequiredMethodCount: CONTRACT_CHANGE_REQUIRED_METHODS.length,
  cutoverReady: true,
}));

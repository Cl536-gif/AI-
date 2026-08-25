const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const userService = require('./src/services/userService');
const {
  getUserStore,
  setUserStore,
  resetUserStore,
} = require('./src/stores/userStoreProvider');

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-user-service-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'service.sqlite') });
  const userId = 'user-service-test';

  try {
    setUserStore(store, { adapterName: 'SqliteUserStore(test)' });
    assert.strictEqual(getUserStore(), store);

    await userService.ensureUser(userId);
    const updated = await userService.updateProfile(userId, {
      body: { ageYears: 22, heightCm: 165, currentWeightKg: 60 },
    }, { source: 'manual_test' });
    assert.strictEqual(updated.profile.body.currentWeightKg, 60);

    const event = await userService.appendEvent(userId, {
      eventType: 'body_measurement',
      occurredAt: '2026-08-12T10:00:00.000+08:00',
      payload: { weightKg: 60 },
      source: 'user',
      idempotencyKey: 'user-service-weight-1',
    });
    assert.strictEqual(event.payload.weightKg, 60);

    const snapshot = await userService.getUserDataSnapshot(userId);
    assert.strictEqual(snapshot.profile.profile.body.heightCm, 165);
    assert.strictEqual(snapshot.events.length, 1);
    console.log('userService boundary passed (profile + event + snapshot).');
  } finally {
    resetUserStore();
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

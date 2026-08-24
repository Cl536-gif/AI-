const assert = require('assert');
const {
  USER_STORE_METHODS,
  getMissingUserStoreMethods,
} = require('./src/stores/userStoreContract');
const { createTencentPostgresUserStore } = require('./src/stores/tencentPostgresUserStore');
const {
  DATABASE_READY_METHODS,
} = require('./src/stores/tencentPostgresUserStoreCapabilities');

function eventRow(overrides = {}) {
  return {
    event_id: 'event-1',
    event_type: 'meal',
    occurred_at: new Date('2026-08-24T04:00:00.000Z'),
    recorded_at: new Date('2026-08-24T04:00:01.000Z'),
    payload: { meal: 'breakfast' },
    source: 'user',
    idempotency_key: 'event-key-1',
    supersedes_event_id: null,
    status: 'active',
    ...overrides,
  };
}

async function main() {
  const calls = [];
  const userTransactions = [];

  const query = async (text, values) => {
    calls.push({ text, values });
    if (text.includes('resolve_anonymous_identity')) {
      return { rows: [{ result: { userId: 'anon:resolved', existing: false } }] };
    }
    if (text.includes('merge_current_account_from_anonymous')) {
      return { rows: [{ result: { mergeId: '00000000-0000-4000-8000-000000000001', sourceUserId: values[0], targetUserId: 'acct:account-1', status: 'completed' } }] };
    }
    if (text.includes('release_current_merged_sensitive_events')) {
      return { rows: [{ result: 2 }] };
    }
    if (text.includes('append_current_user_event')) {
      const input = JSON.parse(values[0]);
      assert.strictEqual(Object.hasOwn(input, 'userId'), false);
      return { rows: [{ result: { eventId: 'event-rpc', ...input, recordedAt: '2026-08-24T04:00:01.000Z' } }] };
    }
    if (text.includes('record_current_user_consent')) {
      const input = JSON.parse(values[0]);
      assert.strictEqual(Object.hasOwn(input, 'userId'), false);
      return { rows: [{ result: { userId: 'acct:user-1', ...input } }] };
    }
    if (text.includes('FROM app.user_events') && text.includes('event_id = $2')) {
      return { rows: [eventRow()] };
    }
    if (text.includes('FROM app.user_events')) {
      return { rows: [eventRow(), eventRow({ event_id: 'event-2', idempotency_key: null })] };
    }
    if (text.includes('FROM app.user_consents')) {
      return { rows: [{ consent_type: 'long_term_profile', status: 'granted', recorded_at: new Date('2026-08-24T04:01:00.000Z'), source: 'user' }] };
    }
    return { rows: [] };
  };

  const store = createTencentPostgresUserStore({
    async runUserTransaction(userId, callback) {
      userTransactions.push(userId);
      return callback({ query });
    },
    async runPostgresClient(callback) {
      return callback({ query });
    },
  });

  assert.deepStrictEqual(getMissingUserStoreMethods(store), []);
  assert.strictEqual(await store.ensureUser('acct:user-1'), 'acct:user-1');
  assert.strictEqual(
    await store.resolveAnonymousIdentity('a'.repeat(64)),
    'anon:resolved'
  );

  const merge = await store.mergeAnonymousIntoAccount('anon:guest-1', 'account-1');
  assert.strictEqual(merge.targetUserId, 'acct:account-1');
  assert.strictEqual(
    await store.releaseMergedSensitiveEvents(
      'acct:account-1',
      '00000000-0000-4000-8000-000000000001'
    ),
    2
  );

  const appended = await store.appendEvent({
    userId: 'acct:user-1',
    eventType: 'meal',
    occurredAt: '2026-08-24T12:00:00+08:00',
    payload: { meal: 'breakfast' },
    source: 'user',
    idempotencyKey: 'event-key-1',
  });
  assert.strictEqual(appended.userId, 'acct:user-1');
  assert.strictEqual(appended.status, 'active');
  const appendRpcIndex = calls.findIndex((call) => call.text.includes('append_current_user_event'));
  assert(appendRpcIndex > 0);
  assert(calls[appendRpcIndex - 1].text.startsWith('INSERT INTO app.users'));

  const fetched = await store.getEvent('acct:user-1', 'event-1');
  assert.strictEqual(fetched.occurredAt, '2026-08-24T04:00:00.000Z');
  assert.deepStrictEqual(
    (await store.listEvents('acct:user-1', { eventType: 'meal', limit: 999 })).map((event) => event.eventId),
    ['event-1', 'event-2']
  );
  const listCall = calls.find((call) => call.text.includes('event_type = $2'));
  assert.deepStrictEqual(listCall.values, ['acct:user-1', 'meal', 500]);

  const consent = await store.recordConsent({
    userId: 'acct:user-1',
    consentType: 'long_term_profile',
    status: 'granted',
    recordedAt: '2026-08-24T12:01:00+08:00',
    source: 'user',
  });
  assert.strictEqual(consent.userId, 'acct:user-1');
  const latestConsent = await store.getLatestConsent('acct:user-1', 'long_term_profile');
  assert.strictEqual(latestConsent.recordedAt, '2026-08-24T04:01:00.000Z');

  const unavailableMethods = USER_STORE_METHODS
    .filter((methodName) => !DATABASE_READY_METHODS.includes(methodName));
  for (const methodName of unavailableMethods) {
    await assert.rejects(
      store[methodName](),
      (error) => error.code === 'POSTGRES_USER_STORE_METHOD_UNAVAILABLE' &&
        error.methodName === methodName
    );
  }
  assert.strictEqual(unavailableMethods.length, 29);
  await assert.rejects(store.resolveAnonymousIdentity('raw-device-id'), /摘要格式不正确/);
  await assert.rejects(
    store.mergeAnonymousIntoAccount('anon:guest-1', 'acct:forged'),
    /原始账号标识/
  );

  assert(userTransactions.includes('acct:user-1'));
  assert(userTransactions.includes('acct:account-1'));
  assert(calls.every(({ text }) => !text.includes(';')));
  assert(calls.every(({ values }) => Array.isArray(values)));

  console.log(JSON.stringify({
    batch: '004b',
    status: 'PASS',
    implementedMethodCount: 9,
    unavailableMethodCount: 29,
    parameterizedQueriesOnly: true,
    productionAdapterSelectionChanged: false,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

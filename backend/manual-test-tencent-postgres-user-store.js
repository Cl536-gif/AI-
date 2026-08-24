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

function profileSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    body: {
      equationSex: 'female',
      ageYears: 28,
      heightCm: 165,
      currentWeightKg: 59.5,
      targetWeightKg: 56,
      dailyActivity: '久坐',
      recentWeightChange: '下降0.5kg',
    },
    diet: {
      scene: 'mixed',
      cafeteriaMode: 'mixed',
      budgetCnyPerMeal: 30,
      tastePreferences: ['清淡'],
      restrictions: [],
      goals: ['稳定减脂'],
      exerciseBaseline: '每周步行三次',
    },
    menstrualTracking: {
      applicability: 'applicable',
      status: 'active',
    },
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
    if (text.includes('save_current_user_profile_versioned')) {
      const profile = JSON.parse(values[0]);
      assert.deepStrictEqual(JSON.parse(values[3]), ['body']);
      return { rows: [{ result: {
        userId: 'acct:user-1',
        profileVersion: 4,
        profile,
        createdAt: '2026-08-24T04:00:00.000Z',
        updatedAt: '2026-08-24T04:05:00.000Z',
      } }] };
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
    if (text.includes('record_current_user_activity')) {
      return { rows: [{ result: {
        previousActiveAt: '2026-08-24T03:59:00.000Z',
        now: '2026-08-24T04:00:00.000Z',
      } }] };
    }
    if (text.includes('update_current_user_timezone')) {
      return { rows: [{ result: {
        userId: 'acct:user-1',
        timezone: values[0],
        locale: 'zh-CN',
        lastActiveAt: '2026-08-24T04:00:00.000Z',
        createdAt: '2026-08-24T03:00:00.000Z',
      } }] };
    }
    if (text.includes('FROM app.users WHERE user_id = $1 LIMIT 1')) {
      return { rows: [{
        timezone: 'Asia/Shanghai',
        locale: 'zh-CN',
        last_active_at: new Date('2026-08-24T04:00:00.000Z'),
        created_at: new Date('2026-08-24T03:00:00.000Z'),
      }] };
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
    if (text.includes('FROM app.user_profile_versions AS versions')) {
      return { rows: [{
        current_version: 3,
        version_created_at: new Date('2026-08-24T04:00:00.000Z'),
        version_updated_at: new Date('2026-08-24T04:03:00.000Z'),
        schema_version: 1,
        equation_sex: 'female',
        age_years: '28.00',
        height_cm: '165.00',
        current_weight_kg: '59.500',
        target_weight_kg: '56.000',
        daily_activity: '久坐',
        recent_weight_change: '下降0.5kg',
        scene: 'mixed',
        cafeteria_mode: 'mixed',
        budget_cny_per_meal: '30.00',
        taste_preferences: ['清淡'],
        restrictions: [],
        goals: ['稳定减脂'],
        exercise_baseline: '每周步行三次',
        menstrual_applicability: 'applicable',
        menstrual_status: 'active',
      }] };
    }
    if (text.includes('FROM app.user_profile_version_history AS history')) {
      const normal = profileSnapshot();
      delete normal.menstrualTracking;
      return { rows: [
        {
          profile_version: 3,
          normal_revision_id: null,
          menstrual_revision_id: '00000000-0000-4000-8000-000000000003',
          changed_fields: ['menstrualTracking'],
          source: 'user',
          recorded_at: new Date('2026-08-24T04:03:00.000Z'),
          profile_snapshot: normal,
          menstrual_snapshot: { applicability: 'applicable', status: 'active' },
        },
        {
          profile_version: 2,
          normal_revision_id: '00000000-0000-4000-8000-000000000002',
          menstrual_revision_id: null,
          changed_fields: ['body'],
          source: 'user',
          recorded_at: new Date('2026-08-24T04:02:00.000Z'),
          profile_snapshot: normal,
          menstrual_snapshot: null,
        },
      ] };
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

  const profile = await store.getProfile('acct:user-1');
  assert.strictEqual(profile.profileVersion, 3);
  assert.strictEqual(profile.profile.body.currentWeightKg, 59.5);
  assert.strictEqual(profile.profile.menstrualTracking.status, 'active');

  const updatedProfile = await store.updateProfile(
    'acct:user-1',
    { body: { currentWeightKg: 59 } },
    { source: 'user', expectedVersion: 3 }
  );
  assert.strictEqual(updatedProfile.profileVersion, 4);
  assert.strictEqual(updatedProfile.profile.body.currentWeightKg, 59);
  const profileSaveCall = calls.find((call) =>
    call.text.includes('save_current_user_profile_versioned')
  );
  assert.strictEqual(profileSaveCall.values[2], 3);

  const revisions = await store.listProfileRevisions('acct:user-1', { limit: 999 });
  assert.strictEqual(revisions.length, 2);
  assert.strictEqual(revisions[0].profileVersion, 3);
  assert.strictEqual(revisions[0].snapshot.menstrualTracking.status, 'active');
  assert.strictEqual(revisions[1].snapshot.menstrualTracking.status, 'unknown');
  const revisionCall = calls.find((call) =>
    call.text.includes('FROM app.user_profile_version_history AS history')
  );
  assert.deepStrictEqual(revisionCall.values, ['acct:user-1', 200]);

  const activity = await store.recordActivity('acct:user-1');
  assert.deepStrictEqual(activity, {
    previousActiveAt: '2026-08-24T03:59:00.000Z',
    now: '2026-08-24T04:00:00.000Z',
  });
  const settings = await store.getUserSettings('acct:user-1');
  assert.deepStrictEqual(settings, {
    userId: 'acct:user-1',
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    lastActiveAt: '2026-08-24T04:00:00.000Z',
    createdAt: '2026-08-24T03:00:00.000Z',
  });
  const updatedSettings = await store.updateUserTimezone(
    'acct:user-1',
    ' America/New_York '
  );
  assert.strictEqual(updatedSettings.timezone, 'America/New_York');
  const timezoneCall = calls.find((call) =>
    call.text.includes('update_current_user_timezone')
  );
  assert.deepStrictEqual(timezoneCall.values, ['America/New_York']);
  await assert.rejects(
    store.updateUserTimezone('acct:user-1', '   '),
    /用户时区格式不正确/
  );

  const unavailableMethods = USER_STORE_METHODS
    .filter((methodName) => !DATABASE_READY_METHODS.includes(methodName));
  for (const methodName of unavailableMethods) {
    await assert.rejects(
      store[methodName](),
      (error) => error.code === 'POSTGRES_USER_STORE_METHOD_UNAVAILABLE' &&
        error.methodName === methodName
    );
  }
  assert.strictEqual(unavailableMethods.length, 23);
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
    batch: '004d-adapter',
    status: 'PASS',
    implementedMethodCount: 15,
    unavailableMethodCount: 23,
    parameterizedQueriesOnly: true,
    productionAdapterSelectionChanged: false,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

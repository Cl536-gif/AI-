const assert = require('assert');
const {
  createTencentPostgresUserStore,
} = require('./src/stores/tencentPostgresUserStore');

const userId = 'acct:004l_local_snapshot';
const calls = [];

const client = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM app.user_profile_versions AS versions')) return { rows: [] };
    if (sql.includes('FROM app.user_profile_version_history AS history')) return { rows: [] };
    if (sql.includes('FROM app.user_service_status WHERE')) return { rows: [] };
    if (sql.includes('FROM app.user_advice_history')) return { rows: [] };
    if (sql.includes('FROM app.user_events')) return { rows: [] };
    if (sql.includes('FROM app.energy_calculations')) return { rows: [] };
    if (sql.includes('FROM app.user_plan_versions')) return { rows: [] };
    if (sql.includes('FROM app.user_service_transitions')) return { rows: [] };
    throw new Error(`未覆盖的快照SQL：${sql}`);
  },
};

let activeTransactions = 0;
let maxActiveTransactions = 0;
const store = createTencentPostgresUserStore({
  async runUserTransaction(transactionUserId, callback) {
    assert.strictEqual(transactionUserId, userId);
    activeTransactions += 1;
    maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
    try {
      return await callback(client);
    } finally {
      activeTransactions -= 1;
    }
  },
  async runPostgresClient(callback) {
    return callback(client);
  },
});

async function run() {
  const snapshot = await store.getUserDataSnapshot(userId);
  assert.deepStrictEqual(snapshot, {
    userId,
    profile: null,
    profileRevisions: [],
    serviceStatus: null,
    adviceHistory: [],
    events: [],
    energyCalculations: [],
    plans: [],
    serviceTransitions: [],
  });
  assert.strictEqual(calls.length, 8);
  assert.strictEqual(maxActiveTransactions, 1);
  assert(calls.every(({ params }) => params[0] === userId));
  assert.deepStrictEqual(calls.map(({ params }) => params.at(-1)), [
    userId,
    100,
    userId,
    100,
    200,
    100,
    100,
    100,
  ]);

  console.log(JSON.stringify({
    batch: '004l-snapshot-local',
    status: 'PASS',
    methodCount: 1,
    queryCount: calls.length,
    maxConcurrentTransactions: maxActiveTransactions,
    networkUsed: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

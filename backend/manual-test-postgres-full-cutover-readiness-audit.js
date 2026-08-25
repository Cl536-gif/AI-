const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { USER_STORE_METHODS } = require('./src/stores/userStoreContract');
const {
  DATABASE_READY_METHODS,
  assertCompleteCapabilityInventory,
  isTencentPostgresCutoverReady,
} = require('./src/stores/tencentPostgresUserStoreCapabilities');
const {
  FULL_CUTOVER_MODE,
  FULL_CUTOVER_CONFIRMATION,
  assertTencentPostgresCutoverAllowed,
} = require('./src/stores/tencentPostgresCutoverGate');
const {
  resolveLangGraphCheckpointerPolicy,
} = require('./src/langgraph/checkpointerProvider');

const root = __dirname;
const routeSource = fs.readFileSync(path.join(root, 'src/routes/chatLanggraph.js'), 'utf8');
const gateSource = fs.readFileSync(
  path.join(root, 'src/stores/tencentPostgresCutoverGate.js'),
  'utf8'
);
const auditSource = fs.readFileSync(
  path.join(root, 'sql/postgres/005d_full_cutover_readiness.audit.md'),
  'utf8'
);

const inventory = assertCompleteCapabilityInventory();
assert.strictEqual(USER_STORE_METHODS.length, 37);
assert.strictEqual(DATABASE_READY_METHODS.length, 37);
assert.strictEqual(inventory.length, 37);
assert(inventory.every(({ status }) => status === 'database_ready'));
assert.strictEqual(isTencentPostgresCutoverReady(), false);
assert.throws(
  () => assertTencentPostgresCutoverAllowed({
    env: {
      TENCENT_PG_CUTOVER_MODE: FULL_CUTOVER_MODE,
      TENCENT_PG_CUTOVER_CONFIRM: FULL_CUTOVER_CONFIRMATION,
    },
  }),
  (error) => error?.code === 'POSTGRES_FULL_CUTOVER_NOT_READY'
);

const defaultCheckpointerPolicy = resolveLangGraphCheckpointerPolicy({ env: {} });
assert.strictEqual(defaultCheckpointerPolicy.backend, 'memory');
assert.strictEqual(defaultCheckpointerPolicy.shared, false);
assert(routeSource.includes('createLangGraphCheckpointer()'));
assert.throws(
  () => resolveLangGraphCheckpointerPolicy({
    env: {
      USER_STORE_ADAPTER: 'tencent-postgres',
      TENCENT_PG_CUTOVER_MODE: FULL_CUTOVER_MODE,
      TENCENT_PG_CUTOVER_CONFIRM: FULL_CUTOVER_CONFIRMATION,
    },
  }),
  (error) => error?.code === 'LANGGRAPH_SHARED_CHECKPOINTER_REQUIRED'
);
assert(!gateSource.includes('TENCENT_PG_FULL_MAX_INSTANCES'));
assert(!gateSource.includes('TENCENT_PG_FULL_CONNECTION_BUDGET'));

const expectedBlockers = [
  'B1｜LangGraph 会话状态仍是进程内存',
  'B2｜全量模式没有连接容量与实例拓扑门禁',
  'B3｜现有 SQLite 数据去向没有当前证据',
  'B4｜一次图持久化跨多个独立事务',
  'B5｜多实例/重启端到端验证缺失',
  'B6｜运行监控与自动回滚信号不足',
  'B7｜回滚制品与数据回滚演练不足',
  'B8｜备份恢复与传输安全尚未签核',
];
expectedBlockers.forEach((blocker) => assert(auditSource.includes(blocker)));
assert(auditSource.includes('状态：`NOT READY`'));
assert(auditSource.includes('当前禁止：多实例 PostgreSQL'));

console.log(JSON.stringify({
  batch: '005d-full-cutover-readiness-audit',
  status: 'PASS',
  contractMethodCount: USER_STORE_METHODS.length,
  databaseReadyMethodCount: DATABASE_READY_METHODS.length,
  fullCutoverReady: false,
  blockerCount: expectedBlockers.length,
  processLocalCheckpointerDetected: true,
  fullCapacityGateMissing: true,
}));

const { Pool } = require('pg');
const { createWecomPayloadCrypto } = require('../../src/wecom/wecomPayloadCrypto');
const { createWecomPostgresStore } = require('../../src/wecom/wecomPostgresStore');
const { createWecomJobProcessor } = require('../../src/wecom/wecomJobProcessor');
const { createWecomWorker } = require('../../src/wecom/wecomWorker');
const { createDeterministicConversationHandler } = require('./deterministicLangGraph');

const connectionString = process.env.TEST_PG_CONNECTION;
const checkpointSchema = process.env.TEST_CHECKPOINT_SCHEMA;
const payloadKey = process.env.TEST_PAYLOAD_KEY;
const scenario = process.env.TEST_SCENARIO;
const crashPoint = process.env.TEST_CRASH_POINT || '';
const sendUrl = process.env.TEST_SEND_URL;

function stableRequest({ toUser, content, requestId }) {
  return {
    touser: toUser,
    msgtype: 'text',
    agentid: 1000002,
    text: { content },
    enable_duplicate_check: 1,
    duplicate_check_interval: 14400,
    _requestId: requestId,
  };
}

async function main() {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createWecomPostgresStore({
    pool,
    payloadCrypto: createWecomPayloadCrypto(payloadKey),
  });
  async function blockAt(marker, externalTurn) {
    if (crashPoint !== marker) return;
    // LangGraph默认异步刷写上一步checkpoint。中间节点开始后等待刷写完成，
    // 再通知父进程SIGKILL；父进程随后还会独立断言checkpoint_incomplete。
    if (marker === 'checkpointDurable') {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const requestId = externalTurn?.requestId || process.env.TEST_REQUEST_ID;
    await pool.query(`
      INSERT INTO app.wecom_test_crash_signals(scenario,request_id,marker)
      VALUES($1,$2,$3)
      ON CONFLICT(scenario) DO UPDATE SET request_id=excluded.request_id,
        marker=excluded.marker,created_at=now()
    `, [scenario, requestId, marker]);
    if (process.send) process.send({ type: 'crash-ready', scenario, marker, requestId });
    await new Promise(() => {});
  }

  if (crashPoint === 'afterEnqueue') {
    await blockAt('afterEnqueue', { requestId: process.env.TEST_REQUEST_ID });
    return;
  }

  const conversationHandler = createDeterministicConversationHandler({
    pool,
    checkpointSchema,
    hook: blockAt,
  });
  const config = {
    introVersion: 'test-v1',
    workerLeaseMs: 5000,
    workerPollMs: 100,
    workerMaxAttempts: 8,
  };
  const processor = createWecomJobProcessor({
    config,
    store,
    conversationHandler,
    ensureUser: async () => {},
  });
  const apiClient = {
    buildTextRequest: stableRequest,
    async sendText(request) {
      const response = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw Object.assign(new Error('fake upstream failed'), { code: 'TEST_SEND_FAILED' });
      return response.json();
    },
  };
  const hooks = {
    afterLeaseAcquired: ({ job }) => blockAt('afterLeaseAcquired', { requestId: job.requestId }),
    afterConversationProcessed: ({ job }) => blockAt('afterConversationProcessed', {
      requestId: job.requestId,
    }),
    afterOutboxWritten: ({ job }) => blockAt('afterOutboxWritten', { requestId: job.requestId }),
    afterUpstreamAccepted: ({ job }) => blockAt('afterUpstreamAccepted', { requestId: job.requestId }),
  };
  const worker = createWecomWorker({
    config,
    store,
    processor,
    apiClient,
    workerId: `test-worker:${process.pid}`,
    hooks,
    logger: { error() {} },
  });
  try {
    const result = await worker.runOnce();
    process.stdout.write(`${JSON.stringify({ type: 'worker-result', result })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    type: 'worker-error', code: error.code || 'ERROR', message: error.message,
  })}\n`);
  process.exitCode = 1;
});

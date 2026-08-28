const assert = require('assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { fork } = require('child_process');
const { createWecomPayloadCrypto } = require('../../src/wecom/wecomPayloadCrypto');
const { createWecomPostgresStore } = require('../../src/wecom/wecomPostgresStore');
const { classifyExternalTurnSnapshot } = require('../../src/services/graphTurnPersistenceRecovery');
const { createDeterministicGraph } = require('./deterministicLangGraph');
const { startIsolatedPostgres } = require('./testPostgres');

const CHILD = path.resolve(__dirname, 'workerChild.js');
const PAYLOAD_KEY = Buffer.alloc(32, 37).toString('base64');
const SCENARIOS = [
  { id: '01_after_enqueue', crashPoint: 'afterEnqueue', expectedGraphMarker: 'absent' },
  { id: '02_after_lease', crashPoint: 'afterLeaseAcquired', expectedGraphMarker: 'absent' },
  { id: '03_checkpoint_resume', crashPoint: 'checkpointDurable', expectedGraphMarker: 'checkpoint_incomplete' },
  { id: '04_graph_result', crashPoint: 'graphResultGenerated', expectedGraphMarker: 'persistence_pending' },
  { id: '05_persistence_receipt', crashPoint: 'persistenceReceiptWritten', expectedGraphMarker: 'receipt_pending' },
  { id: '06_outbox_written', crashPoint: 'afterOutboxWritten', expectedGraphMarker: 'complete' },
  { id: '07_upstream_accepted', crashPoint: 'afterUpstreamAccepted', expectedGraphMarker: 'complete' },
];

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function startFakeWecomServer() {
  const attempts = new Map();
  const accepted = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const requestId = parsed._requestId;
      attempts.set(requestId, (attempts.get(requestId) || 0) + 1);
      accepted.add(requestId);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, msgId: `fake-${requestId}` }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/send`,
      attempts,
      accepted,
    }));
  });
}

function spawnWorker(env, { waitForCrash = false } = {}) {
  const child = fork(CHILD, [], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (!waitForCrash) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('recovery worker timeout'));
      }, 20000);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolve({ code, signal, stdout, stderr });
        else reject(new Error(`worker failed code=${code} signal=${signal}\n${stdout}\n${stderr}`));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`crash marker timeout: ${env.TEST_SCENARIO}\n${stdout}\n${stderr}`));
    }, 20000);
    child.on('message', (message) => {
      if (message?.type !== 'crash-ready') return;
      clearTimeout(timeout);
      // 这是本测试必须提供的真实强制终止证据；不是异常抛出或模拟状态。
      const killReturned = child.kill('SIGKILL');
      child.once('exit', (code, signal) => resolve({
        code, signal, killReturned, marker: message.marker, stdout, stderr,
      }));
    });
    child.once('error', reject);
  });
}

async function count(pool, sql, params) {
  const result = await pool.query(sql, params);
  return Number(result.rows[0].n);
}

async function run() {
  const postgres = await startIsolatedPostgres();
  const fake = await startFakeWecomServer();
  const store = createWecomPostgresStore({
    pool: postgres.pool,
    payloadCrypto: createWecomPayloadCrypto(PAYLOAD_KEY),
  });
  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      const externalSubjectHash = sha(`subject:${scenario.id}`);
      const recipient = `tester-${scenario.id}`;
      const userId = await store.resolveIdentity(externalSubjectHash, recipient);
      await store.recordIntro(userId, 'test-v1');
      await store.setServiceChoice(userId, 'free');
      await store.markGraphStarted(userId);
      const accepted = await store.enqueueInbound({
        messageKey: `msg-${scenario.id}`,
        inputSha256: sha(`input:${scenario.id}`),
        externalSubjectHash,
        payload: {
          fromUserName: recipient,
          toUserName: 'test-corp',
          msgType: 'text',
          content: '测试崩溃恢复',
          createTime: '1787880000',
          msgId: `msg-${scenario.id}`,
          agentId: '1000002',
        },
      });
      assert.equal(accepted.inserted, true);
      const job = accepted.job;
      const childEnv = {
        TEST_PG_CONNECTION: postgres.connectionString,
        TEST_CHECKPOINT_SCHEMA: postgres.checkpointSchema,
        TEST_PAYLOAD_KEY: PAYLOAD_KEY,
        TEST_SCENARIO: scenario.id,
        TEST_CRASH_POINT: scenario.crashPoint,
        TEST_REQUEST_ID: job.requestId,
        TEST_SEND_URL: fake.url,
      };
      const killed = await spawnWorker(childEnv, { waitForCrash: true });
      assert.equal(killed.killReturned, true);
      assert.equal(killed.signal, 'SIGKILL');
      const crashSignal = await postgres.pool.query(
        'SELECT marker FROM app.wecom_test_crash_signals WHERE scenario=$1', [scenario.id]
      );
      assert.equal(crashSignal.rows[0]?.marker, scenario.crashPoint);

      const graph = createDeterministicGraph({
        pool: postgres.pool,
        checkpointSchema: postgres.checkpointSchema,
      });
      const snapshot = await graph.getState({ configurable: { thread_id: job.threadId } });
      const graphMarker = classifyExternalTurnSnapshot(snapshot, {
        channel: 'wecom', requestId: job.requestId, inputSha256: job.inputSha256,
        operationId: job.graphOperationId,
      }).status;
      assert.equal(graphMarker, scenario.expectedGraphMarker);

      await postgres.pool.query(`
        UPDATE app.wecom_inbound_jobs
        SET locked_until=now()-interval '1 second'
        WHERE request_id=$1 AND status IN ('processing','processed')
      `, [job.requestId]);
      await postgres.pool.query(`
        UPDATE app.wecom_outbound_messages
        SET locked_until=now()-interval '1 second'
        WHERE request_id=$1 AND status='sending'
      `, [job.requestId]);
      const recovery = await spawnWorker({ ...childEnv, TEST_CRASH_POINT: '' });
      assert.match(recovery.stdout, /"claimed":true/);

      const finalJob = await store.getJob(job.requestId);
      const finalState = (await graph.getState({
        configurable: { thread_id: job.threadId },
      })).values;
      const humanMessageCount = (finalState.messages || []).filter(
        (message) => message.id === `wecom:${job.requestId}`
      ).length;
      const langGraphInvocationCount = await count(postgres.pool,
        'SELECT count(*) n FROM app.wecom_test_model_attempts WHERE request_id=$1', [job.requestId]);
      const adviceAppliedCount = await count(postgres.pool,
        'SELECT count(*) n FROM app.wecom_test_advice WHERE request_id=$1', [job.requestId]);
      const outboxCount = await count(postgres.pool,
        'SELECT count(*) n FROM app.wecom_outbound_messages WHERE request_id=$1', [job.requestId]);
      const acceptedSendCount = fake.accepted.has(job.requestId) ? 1 : 0;
      const upstreamRequestAttempts = fake.attempts.get(job.requestId) || 0;
      const result = {
        scenario: scenario.id,
        crashPoint: scenario.crashPoint,
        childKillSignal: killed.signal,
        persistentCrashMarker: crashSignal.rows[0].marker,
        graphMarkerAfterCrash: graphMarker,
        langGraphInvocationCount,
        humanMessageCount,
        adviceAppliedCount,
        outboxCount,
        acceptedSendCount,
        upstreamRequestAttempts,
        finalJobStatus: finalJob.status,
      };
      assert.deepEqual({
        langGraphInvocationCount, humanMessageCount, adviceAppliedCount,
        outboxCount, acceptedSendCount, finalJobStatus: finalJob.status,
      }, {
        langGraphInvocationCount: 1,
        humanMessageCount: 1,
        adviceAppliedCount: 1,
        outboxCount: 1,
        acceptedSendCount: 1,
        finalJobStatus: 'completed',
      });
      if (scenario.id === '07_upstream_accepted') {
        assert.equal(upstreamRequestAttempts, 2);
      } else {
        assert.equal(upstreamRequestAttempts, 1);
      }
      results.push(result);
      console.log(JSON.stringify({ batch: 'wecom-crash-recovery', status: 'PASS', ...result }));
    }
    console.log(JSON.stringify({
      batch: 'wecom-crash-recovery', status: 'PASS',
      scenarioCount: results.length,
      realSigkillCount: results.filter((item) => item.childKillSignal === 'SIGKILL').length,
      checkpointResumeScenario: results.find((item) => item.scenario === '03_checkpoint_resume'),
    }));
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
    await postgres.stop();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    batch: 'wecom-crash-recovery', status: 'FAIL',
    errorCode: error.code || error.name || 'ERROR', message: error.message,
  }));
  process.exitCode = 1;
});

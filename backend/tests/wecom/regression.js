const assert = require('assert/strict');
const crypto = require('crypto');
const express = require('express');
const { createWecomCallbackRouter } = require('../../src/routes/wecomCallback');
const { getWecomConfig } = require('../../src/wecom/wecomConfig');
const { createWecomRuntime } = require('../../src/wecom/wecomRuntime');
const { createWecomPayloadCrypto } = require('../../src/wecom/wecomPayloadCrypto');
const { createWecomPostgresStore } = require('../../src/wecom/wecomPostgresStore');
const { createWecomJobProcessor } = require('../../src/wecom/wecomJobProcessor');
const { createWecomWorker } = require('../../src/wecom/wecomWorker');
const { createWecomApiClient } = require('../../src/wecom/wecomApiClient');
const { truncateUtf8, utf8ByteLength } = require('../../src/wecom/wecomUtf8');
const {
  createSignature, encryptMessage,
} = require('../../src/wecom/wecomCrypto');
const { hashSubject } = require('../../src/wecom/wecomConversationHandler');
const { createDeterministicConversationHandler } = require('./deterministicLangGraph');
const { startIsolatedPostgres } = require('./testPostgres');

const CORP_ID = 'ww-regression-corp';
const AGENT_ID = '1000002';
const TOKEN = 'RegressionToken123';
const ENCODING_AES_KEY = Buffer.from('0123456789abcdef0123456789abcdef')
  .toString('base64').replace(/=$/, '');
const PAYLOAD_KEY = Buffer.alloc(32, 73).toString('base64');

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createConfig(users = []) {
  return {
    enabled: true,
    corpId: CORP_ID,
    agentId: AGENT_ID,
    appSecret: 'regression-secret',
    callbackToken: TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    payloadKeyBase64: PAYLOAD_KEY,
    introVersion: 'regression-v1',
    testAllowlist: users.map((user) => hashSubject(CORP_ID, user)),
    workerPollMs: 100,
    workerLeaseMs: 5000,
    workerMaxAttempts: 8,
    apiTimeoutMs: 5000,
  };
}

function incomingXml({ user, content, msgId, msgType = 'text' }) {
  return '<xml>' +
    `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>` +
    `<FromUserName><![CDATA[${user}]]></FromUserName>` +
    '<CreateTime>1787875200</CreateTime>' +
    `<MsgType><![CDATA[${msgType}]]></MsgType>` +
    `<Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${msgId}</MsgId><AgentID>${AGENT_ID}</AgentID></xml>`;
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function close(server) {
  if (server) await new Promise((resolve) => server.close(resolve));
}

function result(name, assertions) {
  const row = { batch: 'wecom-regression', status: 'PASS', name, ...assertions };
  console.log(JSON.stringify(row));
  return row;
}

async function resetChannelTables(pool) {
  await pool.query(`TRUNCATE TABLE
    app.wecom_outbound_messages,
    app.wecom_graph_receipts,
    app.wecom_inbound_jobs,
    app.wecom_deletion_requests,
    app.wecom_onboarding,
    app.wecom_identities RESTART IDENTITY CASCADE`);
}

async function enqueue(store, { user, content, msgId }) {
  const externalSubjectHash = hashSubject(CORP_ID, user);
  return store.enqueueInbound({
    messageKey: msgId,
    inputSha256: sha(['text', content, '1787875200'].join('\0')),
    externalSubjectHash,
    payload: {
      fromUserName: user, toUserName: CORP_ID, createTime: '1787875200',
      msgType: 'text', content, msgId, agentId: AGENT_ID,
    },
  });
}

async function seedGraphUser(store, user) {
  const userId = await store.resolveIdentity(hashSubject(CORP_ID, user), user);
  await store.recordIntro(userId, 'regression-v1');
  await store.setServiceChoice(userId, 'free');
  await store.markGraphStarted(userId);
  return userId;
}

async function run() {
  const postgres = await startIsolatedPostgres({ checkpointSchema: 'wecom_regression_checkpoint' });
  const store = createWecomPostgresStore({
    pool: postgres.pool,
    payloadCrypto: createWecomPayloadCrypto(PAYLOAD_KEY),
  });
  const rows = [];
  let callbackServer;
  let disabledServer;
  try {
    const callbackUser = 'callback-user';
    const config = createConfig([callbackUser]);
    const configEnv = {
      WECOM_CHANNEL_ENABLED: 'true',
      WECOM_CORP_ID: CORP_ID,
      WECOM_AGENT_ID: AGENT_ID,
      WECOM_APP_SECRET: 'regression-secret',
      WECOM_CALLBACK_TOKEN: TOKEN,
      WECOM_CALLBACK_ENCODING_AES_KEY: ENCODING_AES_KEY,
      WECOM_JOB_PAYLOAD_KEY_BASE64: PAYLOAD_KEY,
      WECOM_TEST_ALLOWLIST: hashSubject(CORP_ID, callbackUser),
    };
    assert.equal(getWecomConfig(configEnv).callbackToken, TOKEN);
    let invalidCallbackTokenRejectedCount = 0;
    for (const invalidToken of ['contains-hyphen', 'A'.repeat(33)]) {
      assert.throws(() => getWecomConfig({
        ...configEnv, WECOM_CALLBACK_TOKEN: invalidToken,
      }), /1—32位英文或数字/);
      invalidCallbackTokenRejectedCount += 1;
    }
    const app = express();
    app.use(express.text({ type: ['text/xml', 'application/xml'], limit: '256kb' }));
    app.use(createWecomCallbackRouter({ config, store }));
    app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
      res.status(error.statusCode || 500).type('text/plain').send(error.message);
    });
    callbackServer = await listen(app);
    const baseUrl = `http://127.0.0.1:${callbackServer.address().port}/`;

    const echoEncrypted = encryptMessage('echo-ok', {
      encodingAesKey: ENCODING_AES_KEY, receiveId: CORP_ID,
    });
    const echoTimestamp = '1787875199';
    const echoNonce = 'echo-nonce';
    const echoUrl = new URL(baseUrl);
    echoUrl.searchParams.set('timestamp', echoTimestamp);
    echoUrl.searchParams.set('nonce', echoNonce);
    echoUrl.searchParams.set('echostr', echoEncrypted);
    echoUrl.searchParams.set('msg_signature',
      createSignature(TOKEN, echoTimestamp, echoNonce, echoEncrypted));
    const echoResponse = await fetch(echoUrl);
    const echoBody = await echoResponse.text();
    assert.equal(echoResponse.status, 200);
    assert.equal(echoBody, 'echo-ok');
    rows.push(result('01_get_callback_verification', {
      httpStatus: echoResponse.status, decryptedEchoMatches: Number(echoBody === 'echo-ok'),
      validCallbackTokenAcceptedCount: 1, invalidCallbackTokenRejectedCount,
    }));

    async function postCallback(msgId) {
      const timestamp = '1787875200';
      const nonce = `nonce-${msgId}`;
      const encrypted = encryptMessage(incomingXml({
        user: callbackUser, content: '回调测试', msgId,
      }), { encodingAesKey: ENCODING_AES_KEY, receiveId: CORP_ID });
      const url = new URL(baseUrl);
      url.searchParams.set('timestamp', timestamp);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('msg_signature', createSignature(TOKEN, timestamp, nonce, encrypted));
      const started = Date.now();
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'text/xml' },
        body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
      });
      return { response, body: await response.text(), elapsedMs: Date.now() - started };
    }
    const callback = await postCallback('callback-1001');
    assert.equal(callback.response.status, 200);
    assert.equal(callback.body, '');
    const queued = Number((await postgres.pool.query(
      'SELECT count(*) n FROM app.wecom_inbound_jobs WHERE message_key=$1', ['callback-1001']
    )).rows[0].n);
    assert.equal(queued, 1);
    const rejectedTimestamp = '1787875200';
    const rejectedNonce = 'nonce-rejected';
    const rejectedEncrypted = encryptMessage(incomingXml({
      user: callbackUser, content: '签名应被拒绝', msgId: 'callback-rejected',
    }), { encodingAesKey: ENCODING_AES_KEY, receiveId: CORP_ID });
    const rejectedUrl = new URL(baseUrl);
    rejectedUrl.searchParams.set('timestamp', rejectedTimestamp);
    rejectedUrl.searchParams.set('nonce', rejectedNonce);
    rejectedUrl.searchParams.set('msg_signature', '0'.repeat(40));
    const rejectedResponse = await fetch(rejectedUrl, {
      method: 'POST', headers: { 'content-type': 'text/xml' },
      body: `<xml><Encrypt><![CDATA[${rejectedEncrypted}]]></Encrypt></xml>`,
    });
    const rejectedRows = Number((await postgres.pool.query(
      'SELECT count(*) n FROM app.wecom_inbound_jobs WHERE message_key=$1',
      ['callback-rejected']
    )).rows[0].n);
    assert.equal(rejectedResponse.status, 403);
    assert.equal(rejectedRows, 0);
    rows.push(result('02_post_signature_aes_decryption', {
      httpStatus: callback.response.status, decryptedAndQueuedCount: queued,
      invalidSignatureRejectedCount: 1, invalidSignatureStoredJobCount: rejectedRows,
    }));
    assert(callback.elapsedMs < 1000);
    rows.push(result('03_postgres_commit_fast_empty_200', {
      httpStatus: callback.response.status, responseBytes: Buffer.byteLength(callback.body),
      elapsedMs: callback.elapsedMs, committedJobCount: queued,
    }));

    const duplicate = await postCallback('callback-1001');
    const duplicateRows = Number((await postgres.pool.query(
      'SELECT count(*) n FROM app.wecom_inbound_jobs WHERE message_key=$1', ['callback-1001']
    )).rows[0].n);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicateRows, 1);
    rows.push(result('10_duplicate_msgid_deduplicated', {
      callbackAttempts: 2, storedJobCount: duplicateRows,
      secondHttpStatus: duplicate.response.status,
    }));

    await resetChannelTables(postgres.pool);
    const graphUser = 'normal-worker-user';
    await seedGraphUser(store, graphUser);
    const normalJob = (await enqueue(store, {
      user: graphUser, content: '今天午餐怎么吃', msgId: 'worker-1001',
    })).job;
    const conversationHandler = createDeterministicConversationHandler({
      pool: postgres.pool, checkpointSchema: postgres.checkpointSchema,
    });
    let proactiveSendCount = 0;
    const apiClient = {
      buildTextRequest: ({ toUser, content, requestId }) => ({
        touser: toUser, text: { content }, _requestId: requestId,
      }),
      async sendText(request) {
        proactiveSendCount += 1;
        return { accepted: true, msgId: `normal-${request._requestId}` };
      },
    };
    const processor = createWecomJobProcessor({
      config: createConfig([graphUser]), store, conversationHandler, ensureUser: async () => {},
    });
    const worker = createWecomWorker({
      config: createConfig([graphUser]), store, processor, apiClient,
      workerId: 'regression-worker', logger: { error() {} },
    });
    const workerResult = await worker.runOnce();
    assert.equal(workerResult.claimed, true);
    assert.equal((await store.getJob(normalJob.requestId)).status, 'completed');
    rows.push(result('04_normal_worker_claim', {
      claimedCount: Number(workerResult.claimed), completedJobCount: 1,
    }));
    const modelCalls = Number((await postgres.pool.query(
      'SELECT count(*) n FROM app.wecom_test_model_attempts WHERE request_id=$1', [normalJob.requestId]
    )).rows[0].n);
    assert.equal(modelCalls, 1);
    rows.push(result('06_shared_langgraph_path', {
      langGraphInvocationCount: modelCalls, graphReceiptCount: 1,
    }));
    assert.equal(proactiveSendCount, 1);
    rows.push(result('09_proactive_send', {
      proactiveSendAttempts: proactiveSendCount, acceptedSendCount: 1,
    }));

    await resetChannelTables(postgres.pool);
    const flowConfig = createConfig(['flow-free', 'flow-long', 'flow-delete']);
    let sharedCalls = 0;
    const flowProcessor = createWecomJobProcessor({
      config: flowConfig,
      store,
      ensureUser: async () => {},
      conversationHandler: async () => {
        sharedCalls += 1;
        return { reply: 'shared', replies: ['shared'] };
      },
    });
    async function processDirect(user, content, msgId) {
      const acceptedJob = await enqueue(store, { user, content, msgId });
      return flowProcessor({ job: acceptedJob.job, payload: store.decryptJobPayload(acceptedJob.job) });
    }
    const intro = await processDirect('flow-free', '你好', 'flow-1');
    const free = await processDirect('flow-free', '免费问答', 'flow-2');
    const freeGraph = await processDirect('flow-free', '午餐怎么吃', 'flow-3');
    const longIntro = await processDirect('flow-long', '你好', 'flow-4');
    const longChoice = await processDirect('flow-long', '长期方案', 'flow-5');
    const deletionIntro = await processDirect('flow-delete', '你好', 'flow-6');
    const deletion = await processDirect('flow-delete', '删除我的账号', 'flow-7');
    assert.match(intro.responseText, /19\.9元/);
    assert.match(free.responseText, /免费问答/);
    assert.equal(freeGraph.responseText, 'shared');
    assert.match(longIntro.responseText, /19\.9元/);
    assert.match(longChoice.responseText, /开始建档/);
    assert.match(deletionIntro.responseText, /19\.9元/);
    assert.match(deletion.responseText, /注销申请/);
    const deletionCount = Number((await postgres.pool.query(
      'SELECT count(*) n FROM app.wecom_deletion_requests'
    )).rows[0].n);
    assert.equal(deletionCount, 1);
    rows.push(result('05_onboarding_pricing_choices_deletion', {
      introMatchedCount: 3, freeChoiceMatchedCount: 1, longChoiceMatchedCount: 1,
      sharedConversationCount: sharedCalls, deletionRequestCount: deletionCount,
    }));

    let tokenFetchCount = 0;
    let sendFetchCount = 0;
    const tokenClient = createWecomApiClient({
      config: createConfig(['token-user']),
      fetchImpl: async (url) => {
        if (String(url).includes('/gettoken')) {
          tokenFetchCount += 1;
          return { ok: true, json: async () => ({
            errcode: 0, access_token: `token-${tokenFetchCount}`, expires_in: 7200,
          }) };
        }
        sendFetchCount += 1;
        if (sendFetchCount === 1) {
          return { ok: true, json: async () => ({ errcode: 40014 }) };
        }
        return { ok: true, json: async () => ({ errcode: 0, msgid: `msg-${sendFetchCount}` }) };
      },
    });
    await tokenClient.sendText({ toUser: 'token-user', content: 'one', requestId: crypto.randomUUID() });
    await tokenClient.sendText({ toUser: 'token-user', content: 'two', requestId: crypto.randomUUID() });
    assert.equal(tokenFetchCount, 2);
    assert.equal(sendFetchCount, 3);
    rows.push(result('07_access_token_cache_refresh', {
      tokenFetchCount, invalidTokenRefreshCount: 1, proactiveApiRequestCount: sendFetchCount,
      cacheReuseCount: 1,
    }));

    const oversized = '饮'.repeat(1000);
    const truncated = truncateUtf8(oversized, 2048);
    const bytes = utf8ByteLength(truncated);
    assert(bytes <= 2048);
    assert(!truncated.includes('\ufffd'));
    rows.push(result('08_utf8_safe_2048_truncation', {
      inputBytes: utf8ByteLength(oversized), outputBytes: bytes,
      replacementCharacterCount: (truncated.match(/\ufffd/g) || []).length,
    }));

    await resetChannelTables(postgres.pool);
    const fifo1 = (await enqueue(store, { user: 'fifo-user', content: '一', msgId: 'fifo-1' })).job;
    const fifo2 = (await enqueue(store, { user: 'fifo-user', content: '二', msgId: 'fifo-2' })).job;
    const firstClaim = await store.claimNext({ workerId: 'fifo-a', leaseMs: 5000 });
    const blockedClaim = await store.claimNext({ workerId: 'fifo-b', leaseMs: 5000 });
    assert.equal(firstClaim.requestId, fifo1.requestId);
    assert.equal(blockedClaim, null);
    await postgres.pool.query(`UPDATE app.wecom_inbound_jobs SET status='completed',
      locked_by=NULL,locked_until=NULL WHERE request_id=$1`, [fifo1.requestId]);
    const secondClaim = await store.claimNext({ workerId: 'fifo-b', leaseMs: 5000 });
    assert.equal(secondClaim.requestId, fifo2.requestId);
    rows.push(result('11_same_member_fifo', {
      firstClaimSequence: firstClaim.sequenceId, blockedConcurrentClaimCount: 1,
      secondClaimSequence: secondClaim.sequenceId,
    }));

    await resetChannelTables(postgres.pool);
    const parallelA = (await enqueue(store, { user: 'parallel-a', content: 'A', msgId: 'parallel-a' })).job;
    const parallelB = (await enqueue(store, { user: 'parallel-b', content: 'B', msgId: 'parallel-b' })).job;
    const claimA = await store.claimNext({ workerId: 'parallel-1', leaseMs: 5000 });
    const claimB = await store.claimNext({ workerId: 'parallel-2', leaseMs: 5000 });
    assert.deepEqual(new Set([claimA.requestId, claimB.requestId]),
      new Set([parallelA.requestId, parallelB.requestId]));
    rows.push(result('12_different_members_parallel', {
      concurrentlyClaimedCount: 2, distinctThreadCount: 2,
    }));

    let disabledNetworkCalls = 0;
    const disabledConfig = { enabled: false };
    const disabledRuntime = createWecomRuntime({
      config: disabledConfig,
      dependencies: {
        get store() { disabledNetworkCalls += 1; throw new Error('must not load'); },
      },
    });
    disabledRuntime.start();
    const disabledApp = express();
    disabledApp.use(createWecomCallbackRouter({ config: disabledConfig }));
    disabledServer = await listen(disabledApp);
    const disabledResponse = await fetch(`http://127.0.0.1:${disabledServer.address().port}/`);
    assert.equal(disabledResponse.status, 404);
    assert.equal(disabledNetworkCalls, 0);
    rows.push(result('13_disabled_no_route_worker_or_network', {
      callbackHttpStatus: disabledResponse.status, workerCreatedCount: 0,
      workerActiveCount: disabledRuntime.worker ? 1 : 0, networkCallCount: disabledNetworkCalls,
    }));

    assert.equal(rows.length, 13);
    console.log(JSON.stringify({
      batch: 'wecom-regression', status: 'PASS', regressionItemCount: rows.length,
      wecomChannelEnabledDuringTests: false, realCredentialsUsed: false,
    }));
  } finally {
    await close(callbackServer);
    await close(disabledServer);
    await postgres.stop();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    batch: 'wecom-regression', status: 'FAIL',
    errorCode: error.code || error.name || 'ERROR', message: error.message,
  }));
  process.exitCode = 1;
});

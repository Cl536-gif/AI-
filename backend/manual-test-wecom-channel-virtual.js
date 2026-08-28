const assert = require('assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createWecomCallbackRouter } = require('./src/routes/wecomCallback');
const { getWecomConfig } = require('./src/wecom/wecomConfig');
const { createWecomPayloadCrypto } = require('./src/wecom/wecomPayloadCrypto');
const { createWecomPostgresStore } = require('./src/wecom/wecomPostgresStore');
const { createWecomJobProcessor } = require('./src/wecom/wecomJobProcessor');
const { createWecomWorker } = require('./src/wecom/wecomWorker');
const { createWecomApiClient } = require('./src/wecom/wecomApiClient');
const { createSignature, encryptMessage } = require('./src/wecom/wecomCrypto');
const { hashSubject } = require('./src/wecom/wecomConversationHandler');
const { createDeterministicConversationHandler } = require('./tests/wecom/deterministicLangGraph');
const { startIsolatedPostgres } = require('./tests/wecom/testPostgres');

const CORP_ID = 'wwVirtualCorp20260828';
const AGENT_ID = '1000002';
const APP_SECRET = 'VirtualAppSecret20260828';
const CALLBACK_TOKEN = 'VirtualToken20260828';
const ENCODING_AES_KEY = Buffer.from('0123456789abcdef0123456789abcdef')
  .toString('base64').replace(/=$/, '');
const PAYLOAD_KEY = Buffer.alloc(32, 86).toString('base64');
const MEMBER_ID = 'virtual-member-a';
const CREATE_TIME = '1787875200';

function output(name, assertions) {
  const row = { batch: 'wecom-channel-virtual-integration', status: 'PASS', name, ...assertions };
  console.log(JSON.stringify(row));
  return row;
}

function buildIncomingXml({ content, msgId, agentId = AGENT_ID, memberId = MEMBER_ID }) {
  return '<xml>' +
    `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>` +
    `<FromUserName><![CDATA[${memberId}]]></FromUserName>` +
    `<CreateTime>${CREATE_TIME}</CreateTime>` +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${msgId}</MsgId>` +
    `<AgentID>${agentId}</AgentID>` +
    '</xml>';
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

async function createVirtualWecomServer() {
  const state = {
    tokenFetchCount: 0,
    sendRequestCount: 0,
    acceptedSendCount: 0,
    receivedMessages: [],
  };
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/cgi-bin/gettoken', (req, res) => {
    assert.equal(req.query.corpid, CORP_ID);
    assert.equal(req.query.corpsecret, APP_SECRET);
    state.tokenFetchCount += 1;
    res.json({
      errcode: 0,
      errmsg: 'ok',
      access_token: 'virtual-access-token-20260828',
      expires_in: 7200,
    });
  });
  app.post('/cgi-bin/message/send', (req, res) => {
    state.sendRequestCount += 1;
    assert.equal(req.query.access_token, 'virtual-access-token-20260828');
    assert.equal(req.body.touser, MEMBER_ID);
    assert.equal(req.body.msgtype, 'text');
    assert.equal(req.body.agentid, Number(AGENT_ID));
    assert.equal(req.body.enable_duplicate_check, 1);
    assert.equal(req.body.duplicate_check_interval, 14400);
    assert(Buffer.byteLength(req.body.text.content, 'utf8') <= 2048);
    state.acceptedSendCount += 1;
    state.receivedMessages.push(req.body);
    res.json({
      errcode: 0,
      errmsg: 'ok',
      msgid: `virtual-upstream-${state.acceptedSendCount}`,
    });
  });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    state,
    async fetchImpl(input, init) {
      const upstreamUrl = new URL(input);
      const localUrl = new URL(`${baseUrl}${upstreamUrl.pathname}${upstreamUrl.search}`);
      return fetch(localUrl, init);
    },
  };
}

async function run() {
  const rows = [];
  let callbackServer;
  let virtualWecom;
  let postgres;
  try {
    const envExample = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
    const productionEnabled = /^WECOM_CHANNEL_ENABLED=true$/m.test(envExample);
    const processEnvironmentEnabled = String(process.env.WECOM_CHANNEL_ENABLED || 'false')
      .trim().toLowerCase() === 'true';
    assert.equal(productionEnabled, false);
    assert.equal(processEnvironmentEnabled, false);
    assert(/^WECOM_CHANNEL_ENABLED=false$/m.test(envExample));
    const disabledConfig = getWecomConfig({ WECOM_CHANNEL_ENABLED: 'false' });
    assert.equal(disabledConfig.enabled, false);
    rows.push(output('01_production_gate_remains_closed', {
      productionChannelEnabled: productionEnabled,
      processEnvironmentChannelEnabled: processEnvironmentEnabled,
      disabledConfigAcceptedCount: 1,
      realCredentialCount: 0,
      externalNetworkRequestCount: 0,
    }));

    postgres = await startIsolatedPostgres({ checkpointSchema: 'wecom_virtual_checkpoint' });
    const config = getWecomConfig({
      WECOM_CHANNEL_ENABLED: 'true',
      WECOM_CORP_ID: CORP_ID,
      WECOM_AGENT_ID: AGENT_ID,
      WECOM_APP_SECRET: APP_SECRET,
      WECOM_CALLBACK_TOKEN: CALLBACK_TOKEN,
      WECOM_CALLBACK_ENCODING_AES_KEY: ENCODING_AES_KEY,
      WECOM_JOB_PAYLOAD_KEY_BASE64: PAYLOAD_KEY,
      WECOM_TEST_ALLOWLIST: hashSubject(CORP_ID, MEMBER_ID),
      WECOM_WORKER_POLL_MS: '100',
      WECOM_WORKER_LEASE_MS: '5000',
      WECOM_WORKER_MAX_ATTEMPTS: '8',
      WECOM_API_TIMEOUT_MS: '5000',
    });
    const store = createWecomPostgresStore({
      pool: postgres.pool,
      payloadCrypto: createWecomPayloadCrypto(PAYLOAD_KEY),
    });
    const conversationHandler = createDeterministicConversationHandler({
      pool: postgres.pool,
      checkpointSchema: postgres.checkpointSchema,
    });
    const processor = createWecomJobProcessor({
      config,
      store,
      conversationHandler,
      ensureUser: async () => {},
    });
    virtualWecom = await createVirtualWecomServer();
    const apiClient = createWecomApiClient({ config, fetchImpl: virtualWecom.fetchImpl });
    const worker = createWecomWorker({
      config,
      store,
      processor,
      apiClient,
      workerId: 'virtual-integration-worker',
      logger: { error() {} },
    });

    const callbackApp = express();
    callbackApp.use(express.text({ type: ['text/xml', 'application/xml'], limit: '256kb' }));
    callbackApp.use(createWecomCallbackRouter({ config, store }));
    callbackApp.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
      res.status(error.statusCode || 500).type('text/plain').send(error.message);
    });
    callbackServer = await listen(callbackApp);
    const callbackBaseUrl = `http://127.0.0.1:${callbackServer.address().port}/`;

    const echoTimestamp = '1787875199';
    const echoNonce = 'VirtualEchoNonce';
    const echoPlaintext = 'virtual-echo-ok';
    const echoEncrypted = encryptMessage(echoPlaintext, {
      encodingAesKey: ENCODING_AES_KEY,
      receiveId: CORP_ID,
    });
    const echoUrl = new URL(callbackBaseUrl);
    echoUrl.searchParams.set('timestamp', echoTimestamp);
    echoUrl.searchParams.set('nonce', echoNonce);
    echoUrl.searchParams.set('echostr', echoEncrypted);
    echoUrl.searchParams.set('msg_signature', createSignature(
      CALLBACK_TOKEN, echoTimestamp, echoNonce, echoEncrypted
    ));
    const echoResponse = await fetch(echoUrl);
    const echoBody = await echoResponse.text();
    assert.equal(echoResponse.status, 200);
    assert.equal(echoBody, echoPlaintext);
    rows.push(output('02_get_callback_signature_and_decryption', {
      httpStatus: echoResponse.status,
      signatureAcceptedCount: 1,
      aesDecryptMatchCount: Number(echoBody === echoPlaintext),
      plaintextResponseBytes: Buffer.byteLength(echoBody, 'utf8'),
    }));

    async function postEncrypted({
      content,
      msgId,
      signatureOverride = null,
      receiveId = CORP_ID,
      agentId = AGENT_ID,
      memberId = MEMBER_ID,
    }) {
      const timestamp = '1787875200';
      const nonce = `VirtualNonce${msgId}`;
      const innerXml = buildIncomingXml({ content, msgId, agentId, memberId });
      const encrypted = encryptMessage(innerXml, {
        encodingAesKey: ENCODING_AES_KEY,
        receiveId,
      });
      const url = new URL(callbackBaseUrl);
      url.searchParams.set('timestamp', timestamp);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('msg_signature', signatureOverride || createSignature(
        CALLBACK_TOKEN, timestamp, nonce, encrypted
      ));
      const startedAt = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8' },
        body: `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName>` +
          `<Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID>${agentId}</AgentID></xml>`,
      });
      return {
        response,
        body: await response.text(),
        elapsedMs: Date.now() - startedAt,
      };
    }

    const invalidSignature = await postEncrypted({
      content: 'invalid-signature', msgId: 'invalid-signature', signatureOverride: '0'.repeat(40),
    });
    const invalidReceiveId = await postEncrypted({
      content: 'invalid-receive-id', msgId: 'invalid-receive-id', receiveId: 'wwWrongCorp',
    });
    const invalidAgent = await postEncrypted({
      content: 'invalid-agent', msgId: 'invalid-agent', agentId: '9999999',
    });
    const invalidAllowlist = await postEncrypted({
      content: 'invalid-allowlist', msgId: 'invalid-allowlist', memberId: 'virtual-member-denied',
    });
    assert.equal(invalidSignature.response.status, 403);
    assert.equal(invalidReceiveId.response.status, 403);
    assert.equal(invalidAgent.response.status, 403);
    assert.equal(invalidAllowlist.response.status, 403);
    const rejectedStoredJobs = Number((await postgres.pool.query(
      "SELECT count(*) n FROM app.wecom_inbound_jobs WHERE message_key LIKE 'invalid-%'"
    )).rows[0].n);
    assert.equal(rejectedStoredJobs, 0);
    rows.push(output('03_invalid_protocol_inputs_rejected', {
      invalidSignatureHttpStatus: invalidSignature.response.status,
      invalidReceiveIdHttpStatus: invalidReceiveId.response.status,
      invalidAgentHttpStatus: invalidAgent.response.status,
      nonAllowlistedMemberHttpStatus: invalidAllowlist.response.status,
      rejectedStoredJobCount: rejectedStoredJobs,
    }));

    async function deliverAndProcess(content, msgId) {
      const callback = await postEncrypted({ content, msgId });
      assert.equal(callback.response.status, 200, callback.body);
      assert.equal(callback.body, '');
      assert(callback.elapsedMs < 5000);
      const jobResult = await postgres.pool.query(
        'SELECT request_id FROM app.wecom_inbound_jobs WHERE message_key=$1', [msgId]
      );
      assert.equal(jobResult.rowCount, 1);
      const workerResult = await worker.runOnce();
      assert.equal(workerResult.claimed, true);
      const job = await store.getJob(jobResult.rows[0].request_id);
      assert.equal(job.status, 'completed');
      return { callback, job, workerResult };
    }

    const intro = await deliverAndProcess('你好', 'virtual-1001');
    assert.match(virtualWecom.state.receivedMessages[0].text.content, /前14天免费试用/);
    assert.match(virtualWecom.state.receivedMessages[0].text.content, /每14天收费19\.9元/);
    rows.push(output('04_encrypted_post_fast_ack_and_intro_push', {
      callbackHttpStatus: intro.callback.response.status,
      callbackResponseBytes: Buffer.byteLength(intro.callback.body),
      callbackElapsedMs: intro.callback.elapsedMs,
      committedInboundJobCount: 1,
      completedJobCount: 1,
      proactiveMessageCount: virtualWecom.state.receivedMessages.length,
      pricingAssertionCount: 2,
    }));

    const freeChoice = await deliverAndProcess('免费问答', 'virtual-1002');
    assert.match(virtualWecom.state.receivedMessages[1].text.content, /已进入免费问答/);
    const onboarding = await postgres.pool.query(`
      SELECT o.service_choice,o.graph_started_at
      FROM app.wecom_onboarding o JOIN app.wecom_identities i ON i.user_id=o.user_id
      WHERE i.external_subject_hash=$1
    `, [hashSubject(CORP_ID, MEMBER_ID)]);
    assert.equal(onboarding.rows[0].service_choice, 'free');
    assert.equal(onboarding.rows[0].graph_started_at, null);
    rows.push(output('05_service_choice_persisted', {
      callbackHttpStatus: freeChoice.callback.response.status,
      freeChoiceMatchedCount: 1,
      onboardingRowCount: onboarding.rowCount,
      serviceChoiceFreeCount: Number(onboarding.rows[0].service_choice === 'free'),
      graphStartedBeforeQuestionCount: Number(onboarding.rows[0].graph_started_at !== null),
    }));

    const graphTurn = await deliverAndProcess('今天午餐怎么吃？', 'virtual-1003');
    assert.equal(virtualWecom.state.receivedMessages[2].text.content, 'deterministic-reply');
    const [modelAttempts, adviceRows, completedJobs, receipts, outbox, identities] = await Promise.all([
      postgres.pool.query('SELECT count(*) n FROM app.wecom_test_model_attempts'),
      postgres.pool.query('SELECT count(*) n FROM app.wecom_test_advice'),
      postgres.pool.query("SELECT count(*) n FROM app.wecom_inbound_jobs WHERE status='completed'"),
      postgres.pool.query('SELECT count(*) n FROM app.wecom_graph_receipts'),
      postgres.pool.query("SELECT count(*) n FROM app.wecom_outbound_messages WHERE status='sent'"),
      postgres.pool.query('SELECT count(*) n FROM app.wecom_identities'),
    ]);
    const modelInvocationCount = Number(modelAttempts.rows[0].n);
    const businessSideEffectCount = Number(adviceRows.rows[0].n);
    const completedJobCount = Number(completedJobs.rows[0].n);
    const receiptCount = Number(receipts.rows[0].n);
    const sentOutboxCount = Number(outbox.rows[0].n);
    const identityCount = Number(identities.rows[0].n);
    assert.equal(modelInvocationCount, 1);
    assert.equal(businessSideEffectCount, 1);
    assert.equal(completedJobCount, 3);
    assert.equal(receiptCount, 3);
    assert.equal(sentOutboxCount, 3);
    assert.equal(identityCount, 1);
    rows.push(output('06_async_langgraph_and_outbox_closed_loop', {
      callbackHttpStatus: graphTurn.callback.response.status,
      langGraphInvocationCount: modelInvocationCount,
      businessSideEffectCount,
      completedJobCount,
      graphReceiptCount: receiptCount,
      sentOutboxCount,
      identityCount,
      deterministicReplyMatchedCount: 1,
    }));

    assert.equal(virtualWecom.state.tokenFetchCount, 1);
    assert.equal(virtualWecom.state.sendRequestCount, 3);
    assert.equal(virtualWecom.state.acceptedSendCount, 3);
    rows.push(output('07_access_token_cache_and_virtual_upstream', {
      accessTokenFetchCount: virtualWecom.state.tokenFetchCount,
      proactiveApiRequestCount: virtualWecom.state.sendRequestCount,
      acceptedSendCount: virtualWecom.state.acceptedSendCount,
      tokenCacheReuseCount: virtualWecom.state.sendRequestCount - virtualWecom.state.tokenFetchCount,
      outboundAgentIdMatchCount: virtualWecom.state.receivedMessages.filter(
        (message) => message.agentid === Number(AGENT_ID)
      ).length,
      outboundRecipientMatchCount: virtualWecom.state.receivedMessages.filter(
        (message) => message.touser === MEMBER_ID
      ).length,
    }));

    const duplicate = await postEncrypted({ content: '今天午餐怎么吃？', msgId: 'virtual-1003' });
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body, '');
    const duplicateWorkerResult = await worker.runOnce();
    assert.equal(duplicateWorkerResult.claimed, false);
    const duplicateJobCount = Number((await postgres.pool.query(
      'SELECT count(*) n FROM app.wecom_inbound_jobs WHERE message_key=$1', ['virtual-1003']
    )).rows[0].n);
    const finalModelAttempts = Number((await postgres.pool.query(
      'SELECT count(*) n FROM app.wecom_test_model_attempts'
    )).rows[0].n);
    assert.equal(duplicateJobCount, 1);
    assert.equal(finalModelAttempts, 1);
    assert.equal(virtualWecom.state.acceptedSendCount, 3);
    rows.push(output('08_duplicate_delivery_remains_idempotent', {
      callbackAttemptCount: 2,
      storedJobCount: duplicateJobCount,
      secondWorkerClaimedCount: Number(duplicateWorkerResult.claimed),
      finalLangGraphInvocationCount: finalModelAttempts,
      finalBusinessSideEffectCount: businessSideEffectCount,
      finalAcceptedSendCount: virtualWecom.state.acceptedSendCount,
    }));

    assert.equal(rows.length, 8);
    console.log(JSON.stringify({
      batch: 'wecom-channel-virtual-integration',
      status: 'PASS',
      integrationItemCount: rows.length,
      virtualCredentialSetCount: 6,
      realCredentialsUsed: false,
      productionWecomChannelEnabled: false,
      externalNetworkRequestCount: 0,
      encryptedInboundMessageCount: 8,
      completedBusinessMessageCount: 3,
      proactiveAcceptedMessageCount: virtualWecom.state.acceptedSendCount,
    }));
  } finally {
    await close(callbackServer);
    if (virtualWecom) await close(virtualWecom.server);
    if (postgres) await postgres.stop();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    batch: 'wecom-channel-virtual-integration',
    status: 'FAIL',
    errorCode: error.code || error.name || 'ERROR',
    message: error.message,
  }));
  process.exitCode = 1;
});

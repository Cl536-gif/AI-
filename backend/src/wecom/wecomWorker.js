const crypto = require('crypto');

function safeCode(error) {
  return String(error?.code || 'WECOM_WORKER_FAILED').replace(/[^A-Z0-9_]/gi, '_').slice(0, 120);
}

function createWecomWorker({
  config,
  store,
  processor,
  apiClient,
  workerId = `${process.env.HOSTNAME || 'local'}:${process.pid}:${crypto.randomUUID()}`,
  hooks = {},
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!config || !store || typeof processor !== 'function' || !apiClient) {
    throw new TypeError('企业微信Worker依赖不完整');
  }
  let accepting = false;
  let loopPromise = null;
  let wakeHandle = null;
  let wakeResolver = null;
  const active = new Set();

  async function callHook(name, context) {
    if (typeof hooks[name] === 'function') await hooks[name](context);
  }

  async function sendExistingOutbox(job) {
    const outbox = await store.readOutbox(job.requestId);
    if (!outbox) throw Object.assign(new Error('Outbox不存在'), { code: 'WECOM_OUTBOX_MISSING' });
    if (outbox.status === 'sent') {
      await store.markSentAndComplete(job.requestId, outbox.upstream_message_id);
      return { accepted: false, alreadySent: true };
    }
    await store.markSending(job.requestId, workerId, config.workerLeaseMs);
    await callHook('afterOutboxClaimed', { job, outbox });
    const sent = await apiClient.sendText(outbox.request);
    await callHook('afterUpstreamAccepted', { job, outbox, sent });
    await store.markSentAndComplete(job.requestId, sent.msgId);
    return sent;
  }

  async function processClaimed(job) {
    const heartbeatHandle = setInterval(() => {
      store.heartbeat(job.requestId, workerId, config.workerLeaseMs).catch(() => {});
    }, Math.max(1000, Math.floor(config.workerLeaseMs / 3)));
    try {
      await callHook('afterLeaseAcquired', { job });
      const evidence = await store.getEvidence(job.requestId);
      if (evidence.outbox) return await sendExistingOutbox(job);
      const payload = store.decryptJobPayload(job);
      let responseText;
      if (evidence.receipt) {
        responseText = (await store.readReceipt(job.requestId)).reply;
      } else {
        const processed = await processor({ job, payload });
        responseText = processed.responseText;
        await callHook('afterConversationProcessed', { job, payload, processed });
      }
      const sendRequest = apiClient.buildTextRequest({
        toUser: payload.fromUserName,
        content: responseText,
        requestId: job.requestId,
      });
      await store.writeReceiptAndOutbox({ job, reply: responseText, sendRequest });
      await callHook('afterOutboxWritten', { job, payload, responseText, sendRequest });
      return await sendExistingOutbox(job);
    } catch (error) {
      const code = safeCode(error);
      if (code === 'WECOM_GRAPH_STATE_CONFLICT') {
        await store.markTerminal(job.requestId, 'state_conflict', code);
      } else if (job.attemptCount >= config.workerMaxAttempts) {
        await store.markTerminal(job.requestId, 'dead_letter', code);
      } else {
        await store.release(job.requestId, workerId, code);
      }
      throw error;
    } finally {
      clearInterval(heartbeatHandle);
    }
  }

  async function runOnce() {
    const job = await store.claimNext({ workerId, leaseMs: config.workerLeaseMs });
    if (!job) return { claimed: false };
    const promise = processClaimed(job);
    active.add(promise);
    try {
      const result = await promise;
      return { claimed: true, requestId: job.requestId, result };
    } finally {
      active.delete(promise);
    }
  }

  async function loop() {
    while (accepting) {
      try {
        const result = await runOnce();
        if (!result.claimed && accepting) {
          await new Promise((resolve) => {
            wakeResolver = resolve;
            wakeHandle = setTimer(resolve, config.workerPollMs);
          });
          wakeHandle = null;
          wakeResolver = null;
        }
      } catch (error) {
        if (logger?.error) logger.error('[wecom-worker] task failed', { code: safeCode(error) });
      }
    }
  }

  function start() {
    if (accepting) return loopPromise;
    accepting = true;
    loopPromise = loop();
    return loopPromise;
  }

  async function stop({ drainMs = 5000 } = {}) {
    accepting = false;
    if (wakeHandle) {
      clearTimer(wakeHandle);
      wakeHandle = null;
      const resolve = wakeResolver;
      wakeResolver = null;
      if (resolve) resolve();
    }
    if (!active.size) return;
    await Promise.race([
      Promise.allSettled([...active]),
      new Promise((resolve) => setTimer(resolve, drainMs)),
    ]);
  }

  return Object.freeze({ start, stop, runOnce, inspect: () => ({ workerId, accepting, active: active.size }) });
}

module.exports = { createWecomWorker, safeCode };

const crypto = require('crypto');
const { getPostgresPool } = require('../db/postgresPool');

const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertHash(value, name) {
  if (!SHA256_HEX.test(String(value || ''))) throw new Error(`${name}格式不正确`);
}

function assertUuid(value, name) {
  if (!UUID.test(String(value || ''))) throw new Error(`${name}格式不正确`);
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function mapJob(row) {
  if (!row) return null;
  return {
    sequenceId: Number(row.sequence_id), requestId: row.request_id,
    messageKey: row.message_key, inputSha256: row.input_sha256,
    graphOperationId: row.graph_operation_id,
    externalSubjectHash: row.external_subject_hash, threadId: row.thread_id,
    payloadCipher: row.payload_cipher, status: row.status, stage: row.stage,
    attemptCount: row.attempt_count, lockedBy: row.locked_by,
    lockedUntil: row.locked_until, lastErrorCode: row.last_error_code,
  };
}

function createWecomPostgresStore({
  pool = getPostgresPool(),
  payloadCrypto,
  now = () => new Date(),
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('企业微信异步存储需要PostgreSQL连接池');
  }
  if (!payloadCrypto) throw new TypeError('企业微信异步存储需要任务密文组件');

  async function enqueueInbound({ messageKey, inputSha256, externalSubjectHash, payload }) {
    assertHash(inputSha256, 'input_sha256');
    assertHash(externalSubjectHash, 'external_subject_hash');
    const requestId = crypto.randomUUID();
    const graphOperationId = crypto.randomUUID();
    const threadId = `wecom:${externalSubjectHash}`;
    const payloadCipher = payloadCrypto.encrypt(payload, requestId);
    const result = await pool.query(`
      INSERT INTO app.wecom_inbound_jobs
        (request_id,message_key,input_sha256,graph_operation_id,
         external_subject_hash,thread_id,payload_cipher)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (message_key) DO NOTHING
      RETURNING *
    `, [requestId, messageKey, inputSha256, graphOperationId,
      externalSubjectHash, threadId, payloadCipher]);
    if (result.rows[0]) return { inserted: true, job: mapJob(result.rows[0]) };
    const existing = await pool.query(
      'SELECT * FROM app.wecom_inbound_jobs WHERE message_key=$1', [messageKey]
    );
    const job = mapJob(existing.rows[0]);
    if (!job || job.inputSha256 !== inputSha256 ||
        job.externalSubjectHash !== externalSubjectHash) {
      return { inserted: false, conflict: true, job };
    }
    return { inserted: false, conflict: false, job };
  }

  async function claimNext({ workerId, leaseMs }) {
    const leaseSeconds = leaseMs / 1000;
    return transaction(pool, async (client) => {
      const result = await client.query(`
        WITH candidate AS (
          SELECT j.request_id
          FROM app.wecom_inbound_jobs j
          WHERE (j.status='queued' OR
                 (j.status IN ('processing','processed') AND j.locked_until < now()))
            AND NOT EXISTS (
              SELECT 1 FROM app.wecom_inbound_jobs earlier
              WHERE earlier.thread_id=j.thread_id
                AND earlier.sequence_id < j.sequence_id
                AND earlier.status NOT IN ('completed','state_conflict','dead_letter')
            )
          ORDER BY j.sequence_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE app.wecom_inbound_jobs j
        SET status='processing', locked_by=$1,
            locked_until=now()+($2::double precision*interval '1 second'),
            attempt_count=attempt_count+1, updated_at=now()
        FROM candidate c
        WHERE j.request_id=c.request_id
        RETURNING j.*
      `, [workerId, leaseSeconds]);
      return mapJob(result.rows[0]);
    });
  }

  async function heartbeat(requestId, workerId, leaseMs) {
    const result = await pool.query(`
      UPDATE app.wecom_inbound_jobs
      SET locked_until=now()+($3::double precision*interval '1 second'), updated_at=now()
      WHERE request_id=$1 AND locked_by=$2 AND status IN ('processing','processed')
    `, [requestId, workerId, leaseMs / 1000]);
    return result.rowCount === 1;
  }

  async function release(requestId, workerId, errorCode) {
    await pool.query(`
      UPDATE app.wecom_inbound_jobs
      SET status='queued', locked_by=NULL, locked_until=NULL,
          last_error_code=$3, updated_at=now()
      WHERE request_id=$1 AND locked_by=$2 AND status IN ('processing','processed')
    `, [requestId, workerId, String(errorCode || 'WECOM_WORKER_FAILED').slice(0, 120)]);
  }

  async function markTerminal(requestId, status, errorCode) {
    if (!['state_conflict', 'dead_letter'].includes(status)) throw new Error('任务终态不正确');
    await pool.query(`
      UPDATE app.wecom_inbound_jobs
      SET status=$2, locked_by=NULL, locked_until=NULL,
          last_error_code=$3, updated_at=now()
      WHERE request_id=$1
    `, [requestId, status, String(errorCode || '').slice(0, 120)]);
  }

  async function getEvidence(requestId) {
    const [receipt, outbox] = await Promise.all([
      pool.query('SELECT * FROM app.wecom_graph_receipts WHERE request_id=$1', [requestId]),
      pool.query('SELECT * FROM app.wecom_outbound_messages WHERE request_id=$1', [requestId]),
    ]);
    return { receipt: receipt.rows[0] || null, outbox: outbox.rows[0] || null };
  }

  async function readReceipt(requestId) {
    const result = await pool.query('SELECT * FROM app.wecom_graph_receipts WHERE request_id=$1', [requestId]);
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, reply: payloadCrypto.decrypt(row.reply_cipher, requestId).reply };
  }

  async function resolveIdentity(externalSubjectHash, recipient) {
    assertHash(externalSubjectHash, 'external_subject_hash');
    const cipher = payloadCrypto.encrypt({ recipient }, externalSubjectHash);
    const result = await pool.query(`
      INSERT INTO app.wecom_identities
        (external_subject_hash,recipient_cipher)
      VALUES ($1,$2)
      ON CONFLICT (external_subject_hash) DO UPDATE
        SET recipient_cipher=excluded.recipient_cipher,last_seen_at=now()
      RETURNING user_id
    `, [externalSubjectHash, cipher]);
    return result.rows[0].user_id;
  }

  async function getOnboarding(userId) {
    const result = await pool.query('SELECT * FROM app.wecom_onboarding WHERE user_id=$1', [userId]);
    const row = result.rows[0];
    return row ? {
      userId, introVersion: row.intro_version, introSentAt: row.intro_sent_at,
      serviceChoice: row.service_choice, graphStartedAt: row.graph_started_at,
    } : null;
  }

  async function recordIntro(userId, version) {
    await pool.query(`
      INSERT INTO app.wecom_onboarding(user_id,intro_version,intro_sent_at)
      VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET
        intro_version=excluded.intro_version,
        intro_sent_at=COALESCE(app.wecom_onboarding.intro_sent_at,excluded.intro_sent_at),
        updated_at=now()
    `, [userId, version]);
  }

  async function setServiceChoice(userId, choice) {
    await pool.query(`
      INSERT INTO app.wecom_onboarding(user_id,service_choice)
      VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET
        service_choice=excluded.service_choice,updated_at=now()
    `, [userId, choice]);
  }

  async function markGraphStarted(userId) {
    await pool.query(`UPDATE app.wecom_onboarding SET
      graph_started_at=COALESCE(graph_started_at,now()),updated_at=now() WHERE user_id=$1`, [userId]);
  }

  async function recordDeletionRequest({ userId, requestType, sourceMessageHash, idempotencyKey }) {
    const status = requestType === 'explicit_deletion' ? 'recorded' : 'pending_confirmation';
    await pool.query(`
      INSERT INTO app.wecom_deletion_requests
        (user_id,request_type,status,source_message_hash,idempotency_key)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING
    `, [userId, requestType, status, sourceMessageHash, idempotencyKey]);
  }

  async function writeReceiptAndOutbox({ job, reply, sendRequest }) {
    const replySha256 = crypto.createHash('sha256').update(reply, 'utf8').digest('hex');
    const replyCipher = payloadCrypto.encrypt({ reply }, job.requestId);
    const outboundId = crypto.createHash('sha256')
      .update(`wecom-outbox:${job.requestId}`).digest('hex');
    const deterministicUuid = `${outboundId.slice(0,8)}-${outboundId.slice(8,12)}-4${outboundId.slice(13,16)}-a${outboundId.slice(17,20)}-${outboundId.slice(20,32)}`;
    const requestJsonCipher = payloadCrypto.encrypt(sendRequest, job.requestId);
    return transaction(pool, async (client) => {
      await client.query(`
        INSERT INTO app.wecom_graph_receipts
          (request_id,input_sha256,graph_operation_id,reply_sha256,reply_cipher)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_id) DO NOTHING
      `, [job.requestId, job.inputSha256, job.graphOperationId, replySha256, replyCipher]);
      await client.query(`
        INSERT INTO app.wecom_outbound_messages
          (outbound_id,request_id,request_json_cipher)
        VALUES($1,$2,$3) ON CONFLICT(request_id) DO NOTHING
      `, [deterministicUuid, job.requestId, requestJsonCipher]);
      await client.query(`
        UPDATE app.wecom_inbound_jobs SET status='processed',stage='outbox_written',
          processed_at=COALESCE(processed_at,now()),updated_at=now()
        WHERE request_id=$1 AND locked_by=$2 AND status='processing'
      `, [job.requestId, job.lockedBy]);
      return { replySha256, outboundId: deterministicUuid };
    });
  }

  function decryptJobPayload(job) {
    return payloadCrypto.decrypt(job.payloadCipher, job.requestId);
  }

  async function readOutbox(requestId) {
    const result = await pool.query('SELECT * FROM app.wecom_outbound_messages WHERE request_id=$1', [requestId]);
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, request: payloadCrypto.decrypt(row.request_json_cipher, requestId) };
  }

  async function markSending(requestId, workerId, leaseMs) {
    const result = await pool.query(`UPDATE app.wecom_outbound_messages SET
      status='sending',attempt_count=attempt_count+1,locked_by=$2,
      locked_until=now()+($3::double precision*interval '1 second'),updated_at=now()
      WHERE request_id=$1 AND status IN ('queued','sending') RETURNING *`,
    [requestId, workerId, leaseMs / 1000]);
    return result.rows[0] || null;
  }

  async function markSentAndComplete(requestId, upstreamMessageId) {
    return transaction(pool, async (client) => {
      await client.query(`UPDATE app.wecom_outbound_messages SET
        status='sent',upstream_message_id=$2,sent_at=now(),locked_by=NULL,
        locked_until=NULL,updated_at=now() WHERE request_id=$1`, [requestId, upstreamMessageId]);
      await client.query(`UPDATE app.wecom_inbound_jobs SET
        status='completed',stage='sent',completed_at=now(),locked_by=NULL,
        locked_until=NULL,updated_at=now() WHERE request_id=$1`, [requestId]);
    });
  }

  async function getJob(requestId) {
    const result = await pool.query('SELECT * FROM app.wecom_inbound_jobs WHERE request_id=$1', [requestId]);
    return mapJob(result.rows[0]);
  }

  return Object.freeze({
    enqueueInbound, claimNext, heartbeat, release, markTerminal, getEvidence, readReceipt,
    resolveIdentity, getOnboarding, recordIntro, setServiceChoice, markGraphStarted,
    recordDeletionRequest, writeReceiptAndOutbox, decryptJobPayload, readOutbox,
    markSending, markSentAndComplete, getJob, now,
  });
}

module.exports = { createWecomPostgresStore, mapJob, transaction };

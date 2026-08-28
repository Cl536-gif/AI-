const SHA256_HEX = /^[a-f0-9]{64}$/;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error('企业微信开关只能是 true 或 false');
}

function parseAllowlist(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => {
      if (!SHA256_HEX.test(item)) throw new Error('企业微信测试白名单必须使用SHA-256摘要');
      return item;
    });
}

function getWecomConfig(env = process.env) {
  const enabled = parseBoolean(env.WECOM_CHANNEL_ENABLED, false);
  const config = {
    enabled,
    corpId: String(env.WECOM_CORP_ID || '').trim(),
    agentId: String(env.WECOM_AGENT_ID || '').trim(),
    appSecret: String(env.WECOM_APP_SECRET || '').trim(),
    callbackToken: String(env.WECOM_CALLBACK_TOKEN || '').trim(),
    encodingAesKey: String(env.WECOM_CALLBACK_ENCODING_AES_KEY || '').trim(),
    introVersion: String(env.WECOM_INTRO_VERSION || 'v1').trim(),
    // 关闭时完全忽略渠道专用值，避免残留配置影响现有服务启动。
    testAllowlist: enabled ? parseAllowlist(env.WECOM_TEST_ALLOWLIST) : [],
    payloadKeyBase64: String(env.WECOM_JOB_PAYLOAD_KEY_BASE64 || '').trim(),
    workerPollMs: Number(env.WECOM_WORKER_POLL_MS || 1000),
    workerLeaseMs: Number(env.WECOM_WORKER_LEASE_MS || 30000),
    workerMaxAttempts: Number(env.WECOM_WORKER_MAX_ATTEMPTS || 8),
    apiTimeoutMs: Number(env.WECOM_API_TIMEOUT_MS || 10000),
  };

  if (!enabled) return config;
  const missing = [
    ['WECOM_CORP_ID', config.corpId],
    ['WECOM_AGENT_ID', config.agentId],
    ['WECOM_APP_SECRET', config.appSecret],
    ['WECOM_CALLBACK_TOKEN', config.callbackToken],
    ['WECOM_CALLBACK_ENCODING_AES_KEY', config.encodingAesKey],
    ['WECOM_JOB_PAYLOAD_KEY_BASE64', config.payloadKeyBase64],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`企业微信渠道缺少环境变量：${missing.join(', ')}`);
  if (!/^\d+$/.test(config.agentId)) throw new Error('WECOM_AGENT_ID 格式不正确');
  if (!/^[A-Za-z0-9]{1,32}$/.test(config.callbackToken)) {
    throw new Error('WECOM_CALLBACK_TOKEN 必须为1—32位英文或数字');
  }
  if (!/^[A-Za-z0-9]{43}$/.test(config.encodingAesKey)) {
    throw new Error('WECOM_CALLBACK_ENCODING_AES_KEY 必须是43位字符');
  }
  if (Buffer.from(config.payloadKeyBase64, 'base64').length !== 32) {
    throw new Error('WECOM_JOB_PAYLOAD_KEY_BASE64 必须解码为32字节');
  }
  for (const [name, value, min, max] of [
    ['WECOM_WORKER_POLL_MS', config.workerPollMs, 100, 60000],
    ['WECOM_WORKER_LEASE_MS', config.workerLeaseMs, 5000, 300000],
    ['WECOM_WORKER_MAX_ATTEMPTS', config.workerMaxAttempts, 1, 100],
    ['WECOM_API_TIMEOUT_MS', config.apiTimeoutMs, 1000, 60000],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} 必须在${min}到${max}之间`);
    }
  }
  if (!config.testAllowlist.length) {
    throw new Error('内部测试阶段开启企业微信渠道前必须配置 WECOM_TEST_ALLOWLIST');
  }
  return config;
}

module.exports = { getWecomConfig, parseAllowlist };

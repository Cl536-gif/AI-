const OFFICIAL_APP_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/apps';
const OFFICIAL_GENERIC_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 20000;
const PROBE_PROMPT = '仅回复OK';

function createMonitorError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function parseTimeout(env = process.env) {
  const raw = String(env.BAILIAN_MONITOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS).trim();
  if (!/^\d+$/.test(raw)) throw createMonitorError('BAILIAN_MONITOR_CONFIGURATION_INVALID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 3000 || value > 30000) {
    throw createMonitorError('BAILIAN_MONITOR_CONFIGURATION_INVALID');
  }
  return value;
}

function assertProbeConfiguration(env = process.env) {
  const apiKey = String(env.BAILIAN_API_KEY || '').trim();
  const appId = String(env.BAILIAN_APP_ID || '').trim();
  if (!apiKey || !appId) throw createMonitorError('BAILIAN_MONITOR_CREDENTIALS_MISSING');
  if (apiKey.length < 16 || /\s/.test(apiKey) || appId.length < 3 || /\s/.test(appId)) {
    throw createMonitorError('BAILIAN_MONITOR_CREDENTIALS_INVALID');
  }
  return Object.freeze({
    apiKey,
    appId,
    timeoutMs: parseTimeout(env),
    model: 'qwen-plus',
  });
}

function safeFailureText(body) {
  if (!body || typeof body !== 'object') return '';
  return [
    body.code,
    body.message,
    body.error?.code,
    body.error?.message,
  ].filter((value) => typeof value === 'string').join(' ').slice(0, 2000).toLowerCase();
}

function classifyBailianFailure({ status = 0, body = null, error = null } = {}) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return 'BAILIAN_MONITOR_TIMEOUT';
  }
  const text = safeFailureText(body);
  if (
    /overdue|arrearage|good standing|insufficient (?:balance|credit)|account[^ ]* (?:suspend|frozen)|欠费|余额不足|账户冻结/.test(text)
  ) {
    return 'BAILIAN_MONITOR_ACCOUNT_STANDING_FAILED';
  }
  if (
    status === 401
    || status === 403
    || /invalid api[-_ ]?key|authentication|unauthorized|accesskey|invalid.*app/.test(text)
  ) {
    return 'BAILIAN_MONITOR_AUTHENTICATION_FAILED';
  }
  if (status === 429 || /rate.?limit|throttl|too many requests/.test(text)) {
    return 'BAILIAN_MONITOR_RATE_LIMITED';
  }
  if (status >= 500) return 'BAILIAN_MONITOR_UPSTREAM_UNAVAILABLE';
  if (status >= 400) return 'BAILIAN_MONITOR_REQUEST_REJECTED';
  if (error) return 'BAILIAN_MONITOR_NETWORK_FAILED';
  return 'BAILIAN_MONITOR_RESPONSE_INVALID';
}

async function readJson(response) {
  return response.json().catch(() => null);
}

async function executeProbe({ name, url, body, validate, apiKey, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw createMonitorError(classifyBailianFailure({ error }));
  } finally {
    clearTimeout(timer);
  }

  const data = await readJson(response);
  if (!response.ok) {
    throw createMonitorError(classifyBailianFailure({ status: response.status, body: data }));
  }
  if (!validate(data)) throw createMonitorError('BAILIAN_MONITOR_RESPONSE_INVALID');
  return Object.freeze({
    name,
    status: 'healthy',
    httpStatus: response.status,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });
}

async function runBailianDependencyProbe({
  env = process.env,
  fetchImpl = global.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw createMonitorError('BAILIAN_MONITOR_FETCH_REQUIRED');
  const config = assertProbeConfiguration(env);
  const appProbe = await executeProbe({
    name: 'application_completion',
    url: `${OFFICIAL_APP_BASE_URL}/${encodeURIComponent(config.appId)}/completion`,
    body: { input: { prompt: PROBE_PROMPT } },
    validate: (data) => typeof data?.output?.text === 'string' && data.output.text.length > 0,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    fetchImpl,
  });
  const genericProbe = await executeProbe({
    name: 'generic_qwen_plus',
    url: OFFICIAL_GENERIC_URL,
    body: {
      model: config.model,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      temperature: 0,
      max_tokens: 4,
    },
    validate: (data) => typeof data?.choices?.[0]?.message?.content === 'string'
      && data.choices[0].message.content.length > 0,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    fetchImpl,
  });
  return Object.freeze({
    appProbe,
    genericProbe,
    timeoutMs: config.timeoutMs,
    accountStanding: 'verified_by_successful_billable_requests',
    credentialsValidated: true,
    appIdValidated: true,
    responseContentEmitted: false,
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  OFFICIAL_APP_BASE_URL,
  OFFICIAL_GENERIC_URL,
  assertProbeConfiguration,
  classifyBailianFailure,
  createMonitorError,
  runBailianDependencyProbe,
};

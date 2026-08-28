const { createWecomAccessTokenCache } = require('./wecomAccessTokenCache');
const { truncateUtf8 } = require('./wecomUtf8');

const TOKEN_ERRORS = new Set([40014, 42001, 42007, 42009]);

function createWecomApiClient({ config, fetchImpl = fetch, now } = {}) {
  if (!config) throw new TypeError('企业微信API客户端需要配置');
  async function fetchToken() {
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
    url.searchParams.set('corpid', config.corpId);
    url.searchParams.set('corpsecret', config.appSecret);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.apiTimeoutMs) });
    const body = await response.json();
    if (!response.ok || body.errcode) {
      throw Object.assign(new Error('企业微信access_token获取失败'), {
        code: 'WECOM_ACCESS_TOKEN_FAILED', wecomErrcode: body.errcode,
      });
    }
    return { token: body.access_token, expiresIn: body.expires_in };
  }
  const tokenCache = createWecomAccessTokenCache({ fetchToken, now });

  function buildTextRequest({ toUser, content, requestId }) {
    return Object.freeze({
      touser: String(toUser || ''),
      msgtype: 'text',
      agentid: Number(config.agentId),
      text: { content: truncateUtf8(content, 2048) },
      enable_duplicate_check: 1,
      duplicate_check_interval: 14400,
      // 企业微信会忽略未知字段；不把内部ID发给上游，稳定JSON由Outbox保存。
      _requestId: String(requestId || ''),
    });
  }

  async function sendText(input, { retryToken = true } = {}) {
    const token = await tokenCache.get();
    const stable = buildTextRequest({
      toUser: input.toUser || input.touser,
      content: input.content ?? input.text?.content,
      requestId: input.requestId || input._requestId,
    });
    const body = { ...stable };
    delete body._requestId;
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send');
    url.searchParams.set('access_token', token);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    });
    const result = await response.json();
    if (TOKEN_ERRORS.has(result.errcode) && retryToken) {
      tokenCache.invalidate(token);
      return sendText(input, { retryToken: false });
    }
    if (!response.ok || result.errcode) {
      throw Object.assign(new Error('企业微信主动发送失败'), {
        code: 'WECOM_SEND_FAILED', wecomErrcode: result.errcode,
      });
    }
    return { accepted: true, msgId: result.msgid || null, request: stable };
  }

  return Object.freeze({ buildTextRequest, sendText, tokenCache });
}

module.exports = { TOKEN_ERRORS, createWecomApiClient };

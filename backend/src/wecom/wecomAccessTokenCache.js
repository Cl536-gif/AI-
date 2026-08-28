function createWecomAccessTokenCache({
  fetchToken,
  now = () => Date.now(),
  refreshSkewMs = 300000,
} = {}) {
  if (typeof fetchToken !== 'function') throw new TypeError('access_token缓存需要获取函数');
  let cached = null;
  let pending = null;

  async function get() {
    if (cached && cached.expiresAt - refreshSkewMs > now()) return cached.token;
    if (!pending) {
      pending = Promise.resolve().then(fetchToken).then((result) => {
        const token = String(result?.token || '');
        const expiresIn = Number(result?.expiresIn || 0);
        if (!token || !Number.isFinite(expiresIn) || expiresIn < 60) {
          throw new Error('企业微信access_token响应无效');
        }
        cached = { token, expiresAt: now() + expiresIn * 1000 };
        return token;
      }).finally(() => { pending = null; });
    }
    return pending;
  }

  function invalidate(token) {
    if (!token || cached?.token === token) cached = null;
  }

  return Object.freeze({ get, invalidate, inspect: () => cached && { ...cached } });
}

module.exports = { createWecomAccessTokenCache };

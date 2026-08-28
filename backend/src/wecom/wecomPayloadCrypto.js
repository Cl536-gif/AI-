const crypto = require('crypto');

function parseKey(value) {
  const key = Buffer.from(String(value || '').trim(), 'base64');
  if (key.length !== 32) throw new Error('WECOM_JOB_PAYLOAD_KEY_BASE64 必须解码为32字节');
  return key;
}

function createWecomPayloadCrypto(base64Key) {
  const key = parseKey(base64Key);
  return Object.freeze({
    encrypt(value, aad = '') {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(String(aad), 'utf8'));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    decrypt(value, aad = '') {
      const packed = Buffer.from(String(value || ''), 'base64');
      if (packed.length < 29) throw new Error('企业微信任务密文格式不正确');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(String(aad), 'utf8'));
      decipher.setAuthTag(packed.subarray(12, 28));
      return JSON.parse(Buffer.concat([
        decipher.update(packed.subarray(28)),
        decipher.final(),
      ]).toString('utf8'));
    },
  });
}

module.exports = { createWecomPayloadCrypto, parseKey };

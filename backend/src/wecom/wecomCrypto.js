const crypto = require('crypto');

const BLOCK_SIZE = 32;

function createSignature(token, timestamp, nonce, encrypted) {
  return crypto.createHash('sha1')
    .update([token, String(timestamp), String(nonce), encrypted].sort().join(''))
    .digest('hex');
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertSignature({ token, timestamp, nonce, encrypted, signature }) {
  const expected = createSignature(token, timestamp, nonce, encrypted);
  if (!timingSafeEqualText(expected, signature)) {
    const error = new Error('企业微信消息签名验证失败');
    error.code = 'WECOM_SIGNATURE_INVALID';
    error.statusCode = 403;
    throw error;
  }
}

function decodeAesKey(encodingAesKey) {
  if (!/^[A-Za-z0-9]{43}$/.test(String(encodingAesKey || ''))) {
    throw new Error('企业微信 EncodingAESKey 格式不正确');
  }
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== 32) throw new Error('企业微信 EncodingAESKey 长度不正确');
  return key;
}

function pkcs7Pad(buffer) {
  const amount = BLOCK_SIZE - (buffer.length % BLOCK_SIZE);
  return Buffer.concat([buffer, Buffer.alloc(amount, amount)]);
}

function pkcs7Unpad(buffer) {
  if (!buffer.length) throw new Error('企业微信密文为空');
  const amount = buffer[buffer.length - 1];
  if (amount < 1 || amount > BLOCK_SIZE || amount > buffer.length) {
    throw new Error('企业微信密文填充不正确');
  }
  const padding = buffer.subarray(buffer.length - amount);
  if (!padding.every((value) => value === amount)) {
    throw new Error('企业微信密文填充不正确');
  }
  return buffer.subarray(0, buffer.length - amount);
}

function encryptMessage(plaintext, { encodingAesKey, receiveId, randomBytes = crypto.randomBytes } = {}) {
  const key = decodeAesKey(encodingAesKey);
  const message = Buffer.from(String(plaintext), 'utf8');
  const receiveIdBuffer = Buffer.from(String(receiveId), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length, 0);
  const payload = pkcs7Pad(Buffer.concat([randomBytes(16), length, message, receiveIdBuffer]));
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString('base64');
}

function decryptMessage(encrypted, { encodingAesKey, receiveId } = {}) {
  const key = decodeAesKey(encodingAesKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decoded;
  try {
    decoded = Buffer.concat([
      decipher.update(Buffer.from(String(encrypted || ''), 'base64')),
      decipher.final(),
    ]);
  } catch (_error) {
    throw new Error('企业微信消息解密失败');
  }
  const payload = pkcs7Unpad(decoded);
  if (payload.length < 20) throw new Error('企业微信密文内容不完整');
  const messageLength = payload.readUInt32BE(16);
  const messageStart = 20;
  const messageEnd = messageStart + messageLength;
  if (messageEnd > payload.length) throw new Error('企业微信密文长度不正确');
  const plaintext = payload.subarray(messageStart, messageEnd).toString('utf8');
  const actualReceiveId = payload.subarray(messageEnd).toString('utf8');
  if (!timingSafeEqualText(actualReceiveId, receiveId)) {
    const error = new Error('企业微信消息 CorpID 不匹配');
    error.code = 'WECOM_RECEIVE_ID_MISMATCH';
    error.statusCode = 403;
    throw error;
  }
  return plaintext;
}

module.exports = {
  assertSignature,
  createSignature,
  decryptMessage,
  encryptMessage,
};

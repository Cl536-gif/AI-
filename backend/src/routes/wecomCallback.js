const crypto = require('crypto');
const express = require('express');
const { getWecomConfig } = require('../wecom/wecomConfig');
const { hashMessage, hashSubject } = require('../wecom/wecomConversationHandler');
const {
  assertSignature,
  decryptMessage,
} = require('../wecom/wecomCrypto');
const {
  parseEncryptedEnvelope,
  parseIncomingMessage,
} = require('../wecom/wecomXml');

function requireQuery(req, name) {
  const value = req.query?.[name];
  if (typeof value !== 'string' || !value) {
    const error = new Error(`企业微信回调缺少参数：${name}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function createWecomCallbackRouter({
  config = getWecomConfig(),
  store = null,
} = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!config.enabled) return res.status(404).type('text/plain').send('Not Found');
    return next();
  });

  router.get('/', (req, res, next) => {
    try {
      const timestamp = requireQuery(req, 'timestamp');
      const nonce = requireQuery(req, 'nonce');
      const signature = requireQuery(req, 'msg_signature');
      const echostr = requireQuery(req, 'echostr');
      assertSignature({
        token: config.callbackToken,
        timestamp,
        nonce,
        encrypted: echostr,
        signature,
      });
      const plaintext = decryptMessage(echostr, {
        encodingAesKey: config.encodingAesKey,
        receiveId: config.corpId,
      });
      return res.type('text/plain').send(plaintext);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const timestamp = requireQuery(req, 'timestamp');
      const nonce = requireQuery(req, 'nonce');
      const signature = requireQuery(req, 'msg_signature');
      if (typeof req.body !== 'string' || !req.body.trim()) {
        return res.status(400).type('text/plain').send('Bad Request');
      }
      const envelope = parseEncryptedEnvelope(req.body);
      assertSignature({
        token: config.callbackToken,
        timestamp,
        nonce,
        encrypted: envelope.encrypt,
        signature,
      });
      const decryptedXml = decryptMessage(envelope.encrypt, {
        encodingAesKey: config.encodingAesKey,
        receiveId: config.corpId,
      });
      const incoming = parseIncomingMessage(decryptedXml);
      if (incoming.toUserName !== config.corpId) {
        const error = new Error('企业微信回调 CorpID 不匹配');
        error.statusCode = 403;
        throw error;
      }
      if (incoming.agentId && incoming.agentId !== config.agentId) {
        const error = new Error('企业微信回调 AgentID 不匹配');
        error.statusCode = 403;
        throw error;
      }
      if (!store || typeof store.enqueueInbound !== 'function') {
        throw Object.assign(new Error('企业微信异步任务存储未初始化'), { statusCode: 503 });
      }
      const externalSubjectHash = hashSubject(config.corpId, incoming.fromUserName);
      if (!config.testAllowlist.includes(externalSubjectHash)) {
        throw Object.assign(new Error('当前企业微信成员不在内部测试白名单'), {
          code: 'WECOM_TEST_USER_NOT_ALLOWED', statusCode: 403,
        });
      }
      const messageKey = incoming.msgId || hashMessage(
        `${externalSubjectHash}:${incoming.createTime}:${incoming.msgType}:${incoming.content}`
      );
      const inputSha256 = hashMessage(
        `${incoming.msgType}\0${incoming.content || ''}\0${incoming.createTime || ''}`
      );
      const accepted = await store.enqueueInbound({
        messageKey, inputSha256, externalSubjectHash, payload: incoming,
      });
      if (accepted.conflict) {
        throw Object.assign(new Error('企业微信 MsgId 对应内容发生冲突'), {
          code: 'WECOM_MESSAGE_KEY_CONFLICT', statusCode: 409,
        });
      }
      // 企业微信要求5秒内响应。只有PostgreSQL提交成功后才返回空HTTP 200；
      // LangGraph和主动发送全部由租约Worker在后台完成。
      return res.status(200).type('text/plain').send('');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createWecomCallbackRouter };

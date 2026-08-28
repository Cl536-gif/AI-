function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTag(xml, tag, { required = true } = {}) {
  const safeTag = String(tag).replace(/[^A-Za-z0-9_]/g, '');
  const pattern = new RegExp(
    `<${safeTag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))\\s*</${safeTag}>`,
    'i'
  );
  const match = pattern.exec(String(xml || ''));
  if (!match) {
    if (!required) return null;
    throw new Error(`企业微信 XML 缺少字段：${safeTag}`);
  }
  return match[1] !== undefined ? match[1] : decodeXmlText(match[2]);
}

function escapeCdata(value) {
  return String(value || '').replace(/]]>/g, ']]]]><![CDATA[>');
}

function parseEncryptedEnvelope(xml) {
  return {
    encrypt: extractTag(xml, 'Encrypt'),
    toUserName: extractTag(xml, 'ToUserName', { required: false }),
    agentId: extractTag(xml, 'AgentID', { required: false }),
  };
}

function parseIncomingMessage(xml) {
  return {
    toUserName: extractTag(xml, 'ToUserName'),
    fromUserName: extractTag(xml, 'FromUserName'),
    createTime: extractTag(xml, 'CreateTime'),
    msgType: extractTag(xml, 'MsgType'),
    content: extractTag(xml, 'Content', { required: false }) || '',
    msgId: extractTag(xml, 'MsgId', { required: false }),
    agentId: extractTag(xml, 'AgentID', { required: false }),
  };
}

function buildTextMessageXml({ toUserName, fromUserName, content, createTime = Math.floor(Date.now() / 1000) }) {
  return `<xml><ToUserName><![CDATA[${escapeCdata(toUserName)}]]></ToUserName>` +
    `<FromUserName><![CDATA[${escapeCdata(fromUserName)}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime><MsgType><![CDATA[text]]></MsgType>` +
    `<Content><![CDATA[${escapeCdata(content)}]]></Content></xml>`;
}

function buildEncryptedReplyXml({ encrypt, signature, timestamp, nonce }) {
  return `<xml><Encrypt><![CDATA[${escapeCdata(encrypt)}]]></Encrypt>` +
    `<MsgSignature><![CDATA[${escapeCdata(signature)}]]></MsgSignature>` +
    `<TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${escapeCdata(nonce)}]]></Nonce></xml>`;
}

module.exports = {
  buildEncryptedReplyXml,
  buildTextMessageXml,
  extractTag,
  parseEncryptedEnvelope,
  parseIncomingMessage,
};

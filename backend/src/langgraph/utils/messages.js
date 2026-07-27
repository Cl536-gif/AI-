// 消息读取小工具，供各个节点共用，避免每个节点自己重复实现一遍。
function getMessageRole(message) {
  if (!message) return undefined;
  if (typeof message.role === 'string') return message.role;
  if (typeof message._getType === 'function') {
    const type = message._getType();
    return type === 'human' ? 'human' : type;
  }
  return undefined;
}

function getMessageText(message) {
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : '';
}

function findLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (getMessageRole(messages[i]) === 'human') {
      return messages[i];
    }
  }
  return null;
}

module.exports = { getMessageRole, getMessageText, findLastUserMessage };

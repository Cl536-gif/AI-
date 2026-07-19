const config = require('../config');
const localKbBridge = require('./localKbBridge');
const bailianGenericClient = require('./bailianGenericClient');
const { SYSTEM_PROMPT } = require('./systemPrompt');

const TOP_K_PER_KB = 5;

function buildPrompt(question, perKb) {
  const sections = perKb
    .filter((kb) => kb.results.length > 0)
    .map((kb) => {
      const chunks = kb.results
        .slice(0, TOP_K_PER_KB)
        .map((r, i) => `(${i + 1}) ${r.text}`)
        .join('\n');
      return `【知识库: ${kb.kbName}】\n${chunks}`;
    });

  if (sections.length === 0) {
    return `用户问题：${question}\n\n（本地知识库没有检索到相关内容，请基于你自己的通用知识谨慎作答，并提醒用户这一点没有本地资料支撑。）`;
  }

  return `已知资料：\n${sections.join('\n\n')}\n\n请结合以上资料回答用户问题：${question}\n（如果资料里没有能回答问题的内容，请直接说明，不要编造。）`;
}

/**
 * 独立的本地知识库问答链路：本地向量检索 + 通用模型对话接口，跟 /api/chat
 * （百炼 App 自带知识库）完全分开，只用于人工对比两边的命中率和回答质量。
 */
async function sendLocalChatMessage({ message }) {
  const perKb = await localKbBridge.retrieveFromKbs(message, config.localKbNames);
  const prompt = buildPrompt(message, perKb);
  const reply = await bailianGenericClient.chat(prompt, { systemPrompt: SYSTEM_PROMPT });

  return {
    reply,
    retrieved: perKb.map((kb) => ({
      kbName: kb.kbName,
      error: kb.error || null,
      chunks: kb.results.slice(0, TOP_K_PER_KB).map((r) => ({
        text: r.text,
        source: r.source,
        hybridScore: r.hybridScore,
        semanticScore: r.semanticScore,
        keywordScore: r.keywordScore,
      })),
    })),
  };
}

module.exports = { sendLocalChatMessage };

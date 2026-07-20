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

  return `已知资料：\n${sections.join('\n\n')}\n\n请结合以上资料回答用户问题：${question}\n（如果资料里没有能回答问题的内容，请直接说明，不要编造。已知资料里出现的对话示例、话术模板（包括标注了"可用XX说法"的现成台词）只是给你参考语气和场景用的参考素材，不是可以直接输出的成品——你必须自己重新组织一句新的话来回应用户这一次的具体输入，禁止把资料里任何一句现成台词原样搬进回复里。）`;
}

/**
 * 独立的本地知识库问答链路：本地向量检索 + 通用模型对话接口，跟 /api/chat
 * （百炼 App 自带知识库）完全分开，只用于人工对比两边的命中率和回答质量。
 *
 * history 可选：之前几轮的原始对话记录（不含检索资料，只有用户说的话和 AI
 * 的回复），用于支持多轮连续对话。只有"这一轮"的问题会做检索、拼资料，
 * 历史轮次直接原样传给模型，不重复检索。
 */
async function sendLocalChatMessage({ message, history }) {
  const perKb = await localKbBridge.retrieveFromKbs(message, config.localKbNames);
  const prompt = buildPrompt(message, perKb);
  const reply = await bailianGenericClient.chat(prompt, { systemPrompt: SYSTEM_PROMPT, history });

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

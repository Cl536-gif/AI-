// 出方案节点：checkCompleteness 判定六项信息全部确认完毕后，走到这里。
// 检索复用 localKbBridge.retrieveFromKbs（跟 /api/chat-local 用的是
// 同一份检索逻辑，不重写），提示词完整复用 systemPrompt.js，格式
// 兜底接入 formatGuard.js——三样都不重新发明，跟 askNextQuestion
// 是同一套做法。
const config = require('../../config');
const { model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { generateWithFormatGuard } = require('../../services/formatGuard');
const localKbBridge = require('../../services/localKbBridge');
const { SLOT_KEYS, SLOT_LABELS } = require('../state');
const { getMessageRole, getMessageText } = require('../utils/messages');

const TOP_K_PER_KB = 5;

function formatConfirmedSlots(slots) {
  return SLOT_KEYS.map((key) => `${SLOT_LABELS[key]}: ${slots[key].value}`).join('\n');
}

// 拿六项已确认的值拼成检索query，检索跟这个具体用户画像相关的知识库
// 片段（跟 localChatService.js 用当前这句话去检索是同一个思路，只是
// 这里没有"当前这句话"，用六项信息本身代替）。
function buildRetrievalQuery(slots) {
  return SLOT_KEYS.map((key) => slots[key].value).filter(Boolean).join(' ');
}

function formatKnowledgeSections(perKb) {
  return perKb
    .filter((kb) => kb.results.length > 0)
    .map((kb) => {
      const chunks = kb.results
        .slice(0, TOP_K_PER_KB)
        .map((r, i) => `(${i + 1}) ${r.text}`)
        .join('\n');
      return `【知识库: ${kb.kbName}】\n${chunks}`;
    });
}

async function generatePlan(state) {
  const query = buildRetrievalQuery(state.slots);
  const perKb = await localKbBridge.retrieveFromKbs(query, config.localKbNames);
  const knowledgeSections = formatKnowledgeSections(perKb);

  const taskInstruction =
    '【本轮任务】六项信息已经全部确认完毕，现在请按第2条要求先用一句话' +
    '复述已收集到的信息，再给出第一版具体的饮食方案（只给"这一顿/今天"' +
    '这一次的方案，不要甩出多日框架）。已经确认的信息：\n' +
    `${formatConfirmedSlots(state.slots)}\n\n` +
    (knowledgeSections.length > 0
      ? `可参考的知识库资料：\n${knowledgeSections.join('\n\n')}\n\n` +
        '资料里的对话示例、话术模板只是参考语气用的，不能原样搬进回复里，' +
        '也不能直接把资料内容当成必须照搬的方案标准，涉及科普说明时依然' +
        '要遵守第12条学术引用铁律。\n\n'
      : '（本地知识库没有检索到直接相关的内容，基于自己的通用知识谨慎作答。）\n\n') +
    '六项信息该收集到哪一步、要不要出方案，已经由外部状态决定好了（已经' +
    '确认全部收集完毕），你不需要自己判断采集进度，只需要结合上面完整的' +
    '系统规则给出第一版具体方案——尤其注意第9条（默认推荐大众化菜品，' +
    '不要健身向/小众菜品）、第17/23条（分量用"一拳米饭""一掌蔬菜"这类' +
    '生活化类比，禁止精确克数）、第43条（食堂场景下每道菜都要主动带一句' +
    '"如果食堂没有，换成XX"的替代方案，不能默认用户能自己控制烹饪方式）、' +
    '第41条（举例按类别就够，不用过度细化到具体口味/品类）。';

  const userMessages = state.messages
    .filter((m) => getMessageRole(m) === 'human')
    .map((m) => getMessageText(m));

  const { text: replyText } = await generateWithFormatGuard({
    userMessages,
    generate: async (retryInstruction) => {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: taskInstruction },
        ...(retryInstruction ? [{ role: 'system', content: `【重新生成要求】${retryInstruction}` }] : []),
        ...state.messages,
      ];
      const response = await model.invoke(messages);
      return response.content;
    },
  });

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[generatePlan] 检索query:', query);
    // eslint-disable-next-line no-console
    console.log('[generatePlan] 生成的方案:', replyText);
  }

  return {
    messages: [{ role: 'ai', content: replyText }],
    retrieved: perKb,
  };
}

module.exports = { generatePlan };

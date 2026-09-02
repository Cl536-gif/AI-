// 真实HTTP回归：复现浏览器里“食堂→自选→辣→30→羊肉→上镜”的完整路径。
// 默认用3个全新deviceId各跑一遍，确保修复不是模型某一次碰巧措辞正常。
//
// 运行前：cd backend && npm start
// 运行：  cd backend && node src/langgraph/manual-tests/scenario44-cafeteria-real-path-repeat.js
const crypto = require('crypto');
const { getRemainingCollectionSlotKeys } = require('../nodes/askNextQuestion');

const BASE_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';
const REPEAT_COUNT = Number(process.env.REGRESSION_REPEAT_COUNT || 3);
const TURNS = ['食堂', '自选', '辣', '30', '羊肉', '上镜'];
const FINAL_PROGRESS_REGEX = /最后|(?:还|只)(?:差|剩)(?:下)?[^。！？\n]{0,4}(?:一个|一项)/u;

function visibleReplies(data) {
  return (Array.isArray(data.replies) && data.replies.length ? data.replies : [data.reply]).filter(Boolean);
}

async function runPath(runNumber) {
  const deviceId = crypto.randomUUID();
  let threadId = null;

  for (const message of TURNS) {
    const body = { message, deviceId };
    if (threadId) body.threadId = threadId;
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line no-await-in-loop
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    threadId = data.threadId;

    const replies = visibleReplies(data);
    for (const reply of replies) {
      if (/^[\s\uFEFF]*[：:]/u.test(reply)) {
        throw new Error(`第${runNumber}次、用户输入“${message}”后，回复仍以孤立冒号开头：${reply}`);
      }
    }

    const remaining = getRemainingCollectionSlotKeys(data.slots || {});
    if (remaining.length > 1 && replies.some((reply) => FINAL_PROGRESS_REGEX.test(reply))) {
      throw new Error(
        `第${runNumber}次、用户输入“${message}”后仍缺${remaining.length}项，却播报“最后一个”：${replies.join(' / ')}`
      );
    }

    console.log(
      `第${runNumber}次 | 用户：${message} | 剩余${remaining.length}项 | AI：${replies.join(' / ')}`
    );
  }
}

async function main() {
  if (!Number.isInteger(REPEAT_COUNT) || REPEAT_COUNT < 2) {
    throw new Error('REGRESSION_REPEAT_COUNT必须是至少2的整数，不能用单次生成冒充稳定回归');
  }
  for (let run = 1; run <= REPEAT_COUNT; run += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runPath(run);
  }
  console.log(`✅ 真实路径连续${REPEAT_COUNT}次通过：无句首孤立冒号，非最后一项时无错误“最后一个”播报`);
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

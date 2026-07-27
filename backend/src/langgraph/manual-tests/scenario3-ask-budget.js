// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 场景：正常问下一项（预算）。已经确认场景+口味，接下来该问预算了。
// 检查生成的问题有没有出现 markdown 加粗（**）、有没有出现
// "是……还是……"这类排比反问句式、有没有emoji——这些都是 systemPrompt.js
// 第13-16条格式铁律明确禁止的，换成LangGraph架构后必须依然生效。
//
// 运行：cd backend && node src/langgraph/manual-tests/scenario3-ask-budget.js
const { askNextQuestion } = require('../nodes/askNextQuestion');
const { createInitialSlots } = require('../state');

function checkFormatViolations(text) {
  const violations = [];
  if (/\*\*[^*]+\*\*/.test(text)) violations.push('出现了 markdown 加粗 **文字**');
  if (/是[^？?]*[，,][^？?]*还是[^？?]*[？?]/.test(text)) violations.push('疑似出现"是……还是……"排比反问句');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) violations.push('出现了 emoji');
  if (/[A-Za-z]{2,}/.test(text)) violations.push('出现了英文字母（现在没有任何豁免词，包括自称"饮食秘书"也不能有英文）');
  return violations;
}

async function main() {
  const slots = createInitialSlots();
  slots.scene = { value: '食堂自己打饭', confirmed: true };
  slots.taste = { value: '喜欢辣', confirmed: true };

  const state = {
    messages: [
      { role: 'human', content: '我想减脂' },
      { role: 'ai', content: '听到你想减脂，我先给你点个赞，愿意开始本身就不容易～你平时吃饭主要是在食堂，还是点外卖？' },
      { role: 'human', content: '食堂自己打饭' },
      { role: 'ai', content: '好嘞，记下"自己打饭"啦～那你平时口味偏好是什么呀？' },
      { role: 'human', content: '喜欢辣' },
    ],
    slots,
    nextSlotToAsk: 'budget',
    lastAskedSlot: 'taste',
  };

  const result = await askNextQuestion(state);
  const text = result.messages[0].content;

  console.log('=== 生成的问题 ===');
  console.log(text);

  const violations = checkFormatViolations(text);
  console.log('\n=== 格式检查 ===');
  console.log(violations.length === 0 ? '没有发现违规' : violations.join('\n'));

  console.log('\nlastAskedSlot（应该是 "budget"）:', result.lastAskedSlot);
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

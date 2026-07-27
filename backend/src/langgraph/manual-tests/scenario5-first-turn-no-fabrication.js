// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 场景：开场首次触发。用户只打了"你好"，没有提到任何具体诉求。
// 检查生成的开场白有没有编造用户没说过的话（比如"听到你想快点变瘦
// 变美"这种），对应 systemPrompt.js 第36条"中性开场铁律"和第42条
// "禁止编造用户原话铁律"。
//
// 运行：cd backend && node src/langgraph/manual-tests/scenario5-first-turn-no-fabrication.js
const { askNextQuestion } = require('../nodes/askNextQuestion');
const { createInitialSlots } = require('../state');

const FABRICATION_PATTERNS = [
  /变瘦变美/,
  /听到你想/,
  /你说["'“”]/,
];

async function main() {
  const state = {
    messages: [{ role: 'human', content: '你好' }],
    slots: createInitialSlots(),
    nextSlotToAsk: 'scene',
    lastAskedSlot: null,
  };

  const result = await askNextQuestion(state);
  const text = result.messages[0].content;

  console.log('=== 生成的开场白 ===');
  console.log(text);

  const hits = FABRICATION_PATTERNS.filter((p) => p.test(text));
  console.log('\n=== 编造检查 ===');
  console.log(
    hits.length === 0
      ? '没有发现编造用户原话的迹象'
      : `发现疑似编造迹象，命中的模式: ${hits.map((p) => p.toString()).join(', ')}`
  );

  console.log('\n--- 预期：不应该出现任何形式的"用户说了具体诉求"的编造，' +
    '开场应该是中性、开放式的接话，比如先问候+顺势引出场景问题 ---');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

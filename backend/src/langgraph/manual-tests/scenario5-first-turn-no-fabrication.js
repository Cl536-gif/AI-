// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 场景：开场首次触发。用户只打了"你好"，没有提到任何具体诉求。
// 检查生成的开场白有没有编造用户没说过的话（比如"听到你想快点变瘦
// 变美"这种），对应 systemPrompt.js 第36条"中性开场铁律"和第42条
// "禁止编造用户原话铁律"。
//
// 已知观察（完整回归测试时记录，暂不处理）：askNextQuestion 里
// checkAsksTargetSlot 这道语义检测偶尔会把这种最简单的首轮开场白
// （"你好"->问候+顺势问scene）连续3次误判成"没有实质问到目标字段"，
// 触发确定性兜底模板（"不好意思，刚才有点跑偏了……"），而不是自然的
// 开场白——编造检查依然是通过的（没编造用户诉求），但用户看到的第一句
// 话变成了更生硬的兜底话术。这是"正确性优先于自然度"这个既有取舍的
// 一次具体体现，不是新bug。如果以后要专门优化这道语义检测的误判率，
// 首轮开场白这类场景应该优先于对话中段的误判去处理，因为它影响的是
// 用户的第一印象，比中途出现一次更显眼。
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

// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 场景：开场首次触发。用户只打了"你好"，没有提到任何具体诉求。
// 检查生成的开场白有没有编造用户没说过的话（比如"听到你想快点变瘦
// 变美"这种），对应 systemPrompt.js 第36条"中性开场铁律"和第42条
// "禁止编造用户原话铁律"。
//
// 完整回归测试时记录过一个观察：askNextQuestion 里 checkAsksTargetSlot
// 这道语义检测偶尔会把这种最简单的首轮开场白（"你好"->问候+顺势问
// scene）连续3次误判成"没有实质问到目标字段"，触发确定性兜底模板
// （"不好意思，刚才有点跑偏了……"）而不是自然的开场白——这个模板本身
// 不算错误答案，但会让用户看到的第一句话变得生硬，影响第一印象。
//
// 定位下来根因是 checkAsksTargetSlot 这类"分类型判断"任务之前复用了
// 跟对话生成同一个 temperature:0.7 的model实例，带来了不必要的判断
// 噪音——现在已经改成用单独的低temperature classifierModel。这次
// 改成跑5次、同时检查"有没有编造"和"有没有被误判触发兜底模板"两件事，
// 确认这个改动之后误判率是不是真的降下来了。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario5-first-turn-no-fabrication.js
const { askNextQuestion } = require('../nodes/askNextQuestion');
const { createInitialSlots } = require('../state');

const FABRICATION_PATTERNS = [
  /变瘦变美/,
  /听到你想/,
  /你说["'“”]/,
];

const FALLBACK_TEMPLATE_PATTERN = /不好意思，刚才有点跑偏了/;

async function runOnce(round) {
  const state = {
    messages: [{ role: 'human', content: '你好' }],
    slots: createInitialSlots(),
    nextSlotToAsk: 'scene',
    lastAskedSlot: null,
  };

  const result = await askNextQuestion(state);
  const text = result.messages[0].content;

  console.log(`\n第${round}次生成的开场白:`, text);

  const fabricationHits = FABRICATION_PATTERNS.filter((p) => p.test(text));
  const hitFallback = FALLBACK_TEMPLATE_PATTERN.test(text);

  if (fabricationHits.length > 0) {
    console.log(`❌ 发现疑似编造迹象，命中的模式: ${fabricationHits.map((p) => p.toString()).join(', ')}`);
  } else {
    console.log('✅ 没有编造用户原话');
  }

  console.log(hitFallback ? '⚠️  这次触发了兜底模板（说明3次重试仍被误判成没问到scene）' : '✅ 没有触发兜底模板，正常生成了自然开场白');

  return { noFabrication: fabricationHits.length === 0, hitFallback };
}

async function main() {
  console.log('=== 用户只打了"你好"，连续跑5次开场白 ===');

  const results = [];
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOnce(i));
  }

  const fabricationFailCount = results.filter((r) => !r.noFabrication).length;
  const fallbackCount = results.filter((r) => r.hitFallback).length;

  console.log('\n=== 总结 ===');
  console.log(`编造检查：5次里有 ${5 - fabricationFailCount} 次没有编造（预期5/5）`);
  console.log(`兜底模板触发次数：5次里有 ${fallbackCount} 次触发了兜底模板（预期0/5，如果非0说明not_asking_target_slot还有误判）`);

  if (fabricationFailCount === 0 && fallbackCount === 0) {
    console.log('完全符合预期：没有编造，也没有被误判触发兜底模板。');
  } else if (fallbackCount > 0) {
    console.log('仍然存在误判触发兜底模板的情况，低temperature切换后误判率有没有下降，需要跟切换前的对照结果比较。');
  }
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

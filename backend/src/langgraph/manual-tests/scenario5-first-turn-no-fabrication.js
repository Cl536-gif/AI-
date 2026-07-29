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
// 噪音——现在已经改成用单独的低temperature classifierModel。跑5次后
// 确认4/5干净，但剩下1/5暴露了一个不同性质的问题：那次触发兜底模板
// 之前最后一次生成的实际文本很短（只有问候+一句宽泛的话题引入，根本
// 没接"食堂还是外卖"这句必答问题）——不是分类器错判，是生成步骤本身
// 漏掉了必答问题，classifier判"没问到scene"反而是判对的。
//
// 这次把重复次数从5次提到12次，多攒几个失败样本，同时 askNextQuestion.js
// 已经加了"每次重试都打印完整文本"的调试日志（之前只打印违规类型，
// 中间几次重试实际生成了什么看不到），配合 LANGGRAPH_DEBUG=1 一起看，
// 才能判断失败样本是不是有共同结构（比如都发生在"先共情/自我介绍再
// 问问题"这种模式）、长度分布是不是短文本反而更容易漏问、以及有没有
// 其他共性（特定用词/句式）。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario5-first-turn-no-fabrication.js
const { askNextQuestion } = require('../nodes/askNextQuestion');
const { createInitialSlots } = require('../state');

const ROUNDS = 12;

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

  console.log(`\n第${round}次生成的开场白（长度${text.length}字）:`, text);

  const fabricationHits = FABRICATION_PATTERNS.filter((p) => p.test(text));
  const hitFallback = FALLBACK_TEMPLATE_PATTERN.test(text);

  if (fabricationHits.length > 0) {
    console.log(`❌ 发现疑似编造迹象，命中的模式: ${fabricationHits.map((p) => p.toString()).join(', ')}`);
  } else {
    console.log('✅ 没有编造用户原话');
  }

  console.log(hitFallback ? '⚠️  这次触发了兜底模板（说明3次重试仍被误判成没问到scene）' : '✅ 没有触发兜底模板，正常生成了自然开场白');

  return { round, text, length: text.length, noFabrication: fabricationHits.length === 0, hitFallback };
}

async function main() {
  console.log(`=== 用户只打了"你好"，连续跑${ROUNDS}次开场白 ===`);

  const results = [];
  for (let i = 1; i <= ROUNDS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOnce(i));
  }

  const fabricationFailCount = results.filter((r) => !r.noFabrication).length;
  const fallbackResults = results.filter((r) => r.hitFallback);
  const cleanResults = results.filter((r) => !r.hitFallback);

  console.log('\n=== 总结 ===');
  console.log(`编造检查：${ROUNDS}次里有 ${ROUNDS - fabricationFailCount} 次没有编造（预期全部通过）`);
  console.log(`兜底模板触发次数：${ROUNDS}次里有 ${fallbackResults.length} 次触发了兜底模板`);

  if (fallbackResults.length > 0) {
    const avgFallbackLen = fallbackResults.reduce((s, r) => s + r.length, 0) / fallbackResults.length;
    const avgCleanLen = cleanResults.length > 0
      ? cleanResults.reduce((s, r) => s + r.length, 0) / cleanResults.length
      : 0;
    console.log(`\n触发兜底模板那几次的最后一次生成文本，平均长度: ${avgFallbackLen.toFixed(1)}字`);
    console.log(`正常通过那几次的最终文本，平均长度: ${avgCleanLen.toFixed(1)}字`);
    console.log('\n触发兜底模板的轮次明细（配合上面LANGGRAPH_DEBUG打印的每次重试完整文本一起看）：');
    fallbackResults.forEach((r) => {
      console.log(`  第${r.round}轮，最后一次生成长度${r.length}字: ${r.text}`);
    });
  } else {
    console.log('这次没有触发兜底模板的样本，攒不到失败案例做进一步分析。');
  }

  if (fabricationFailCount === 0 && fallbackResults.length === 0) {
    console.log('\n完全符合预期：没有编造，也没有被误判触发兜底模板。');
  }
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

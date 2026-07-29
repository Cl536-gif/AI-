// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 背景：诊断第36条"中性开场铁律"的"抄示例句漏问必答问题"这个bug时，
// 记录过一个系统性风险——systemPrompt.js里其他给了"独立完整示例句"
// 的规则，理论上有同样的风险敞口。第19条"首次诉求认可铁律"就是这样
// 一条：举例给了"听到你想减脂，我先给你点个赞，愿意开始本身就不容易
// ～"这句认可语，如果模型把这句原样抄下来当成完整回复、漏掉后面
// "食堂还是外卖"这个必答场景问题，就是同一类问题。
//
// 用跟 scenario6 完全相同的输入（"我想减脂"，首次触发认可铁律，
// nextSlotToAsk是scene），但改成跑12次、检查有没有出现"回复内容
// 精确等于（或高度近似）第19条那句认可示例、后面没接场景问题"这种
// 半句截断的情况，方法论上完全对齐 scenario5 验证第36条时用的做法。
//
// 运行：cd backend && LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/scenario16-rule19-half-example-check.js
const { askNextQuestion } = require('../nodes/askNextQuestion');
const { createInitialSlots } = require('../state');

const ROUNDS = 12;

const FALLBACK_TEMPLATE_PATTERN = /不好意思，刚才有点跑偏了/;

// 第19条给的认可示例原句，允许"～"和"愿意迈出这一步"这类近义变体，
// 核心特征是：只有认可这一句话，后面没有接场景问题（不含"食堂"
// "外卖"这类字样）。
const RULE19_EXAMPLE_CORE = /听到你想减脂[^。！？\n]*(点个赞|不容易|这一步)/;

function looksLikeBareAcknowledgment(text) {
  const trimmed = text.trim();
  const hasRule19Core = RULE19_EXAMPLE_CORE.test(trimmed);
  const hasSceneQuestion = /食堂|外卖/.test(trimmed);
  return hasRule19Core && !hasSceneQuestion;
}

async function runOnce(round) {
  const state = {
    messages: [{ role: 'human', content: '我想减脂' }],
    slots: createInitialSlots(),
    nextSlotToAsk: 'scene',
    lastAskedSlot: null,
  };

  const result = await askNextQuestion(state);
  const text = result.messages[0].content;

  console.log(`\n第${round}次生成的开场白（长度${text.length}字）:`, text);

  const hitFallback = FALLBACK_TEMPLATE_PATTERN.test(text);
  const bareAck = looksLikeBareAcknowledgment(text);

  console.log(hitFallback ? '⚠️  这次触发了兜底模板（说明3次重试仍被误判成没问到scene）' : '✅ 没有触发兜底模板');
  console.log(
    bareAck
      ? '❌ 最终文本看起来只有第19条的认可句、没接场景问题——疑似复现了同类的半句截断问题'
      : '✅ 没有出现"只抄认可句、漏问场景"的情况'
  );

  return { round, text, length: text.length, hitFallback, bareAck };
}

async function main() {
  console.log(`=== 用户说"我想减脂"（首次触发第19条认可铁律），连续跑${ROUNDS}次 ===`);

  const results = [];
  for (let i = 1; i <= ROUNDS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOnce(i));
  }

  const fallbackCount = results.filter((r) => r.hitFallback).length;
  const bareAckCount = results.filter((r) => r.bareAck).length;

  console.log('\n=== 总结 ===');
  console.log(`兜底模板触发次数：${ROUNDS}次里有 ${fallbackCount} 次`);
  console.log(`"只抄认可句、漏问场景"次数：${ROUNDS}次里有 ${bareAckCount} 次`);

  if (fallbackCount === 0 && bareAckCount === 0) {
    console.log('\n没有复现同类问题，第19条这个系统性风险可以标记"已排除"。');
  } else {
    console.log('\n复现了同类问题，第19条也需要按第36条同样的思路处理（示例句改成完整段落 + 针对性重试分支）。');
  }
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

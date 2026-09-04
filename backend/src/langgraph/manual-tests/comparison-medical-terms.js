const { getFixedProductAnswer } = require('../nodes/askNextQuestion');

async function main() {
  const banned = /(?:处方|开方|诊断|治疗)/;
  for (const input of ['你和 ChatGPT 有什么区别？', '我为什么要付费？']) {
    const reply = getFixedProductAnswer(input);
    if (!reply) throw new Error(`竞品挑战未命中确定性话术：${input}`);
    if (banned.test(reply)) throw new Error(`竞品话术包含禁用医疗术语：${reply}`);
  }
  console.log('✅ 两类竞品挑战均命中确定性回复，且不含禁用医疗术语');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

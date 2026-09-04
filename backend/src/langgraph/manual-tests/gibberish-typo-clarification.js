const {
  askNextQuestion,
  isRecognizedShortInputForSlot,
  shouldClarifyUnrecognizedShortInput,
} = require('../nodes/askNextQuestion');

async function main() {
  for (const text of ['hated', 'abc']) {
    if (!shouldClarifyUnrecognizedShortInput(text, 'restrictions')) {
      throw new Error(`${text} 没有被识别为无意义短输入`);
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await askNextQuestion({
      messages: [{ role: 'human', content: text }],
      slots: {},
      nextSlotToAsk: 'restrictions',
      lastAskedSlot: 'restrictions',
    });
    const reply = result.messages?.[0]?.content || '';
    if (!/没太看懂|打错字/.test(reply)) throw new Error(`${text} 没有请求澄清`);
    if (/焦虑|烦躁|抱抱|崩溃/.test(reply)) throw new Error(`${text} 被过度解读为情绪`);
  }

  const accepted = [
    ['20', 'budget'],
    ['8:30', 'wakeTime'],
    ['yes', 'exercise'],
    ['no', 'restrictions'],
    ['vegan', 'restrictions'],
    ['spicy', 'taste'],
  ];
  for (const [text, slot] of accepted) {
    if (!isRecognizedShortInputForSlot(text, slot)) throw new Error(`${text} 未通过 ${slot} 白名单`);
    if (shouldClarifyUnrecognizedShortInput(text, slot)) throw new Error(`${text} 被误判为乱码`);
  }

  console.log('✅ hated/abc 只请求澄清，不做情绪解读');
  console.log('✅ 20、8:30、yes/no 和当前槽位可接受的英文短答均放行');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

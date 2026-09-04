const {
  askNextQuestion,
  classifyHealthConcern,
} = require('../nodes/askNextQuestion');

async function main() {
  const cases = [
    ['我不吃豆类 会胀气很难受', 'gastrointestinal_reaction'],
    ['吃辣胃不舒服', 'gastrointestinal_reaction'],
    ['吃了拉肚子', 'gastrointestinal_reaction'],
    ['我对虾过敏', 'possible_allergy'],
    ['最近失眠', 'other_body_concern'],
  ];

  for (const [text, expectedCategory] of cases) {
    const category = classifyHealthConcern(text);
    if (category !== expectedCategory) throw new Error(`${text} 分类错误：${category}`);
    // 如果意外回到 model.invoke，这个无模型测试会直接失败。
    // eslint-disable-next-line no-await-in-loop
    const result = await askNextQuestion({
      messages: [{ role: 'human', content: text }],
      slots: {},
      nextSlotToAsk: 'restrictions',
      lastAskedSlot: 'restrictions',
    });
    if (result.messages?.length !== 1) throw new Error(`${text} 没有保持单气泡`);
    const reply = result.messages[0].content;
    if (/焦虑|抱抱|崩溃/.test(reply)) throw new Error(`${text} 被误写成情绪安抚`);
    if (!/医生/.test(reply)) throw new Error(`${text} 缺少就医边界`);
    if (category === 'possible_allergy' && /(?:你|这|就)是过敏|确诊/.test(reply)) {
      throw new Error('疑似过敏话术做了诊断性判断');
    }
  }

  console.log('✅ 肠胃反应、疑似过敏和其他身体问题均走确定性单气泡');
  console.log('✅ 身体不适不会被写成焦虑安抚，疑似过敏不做诊断表述');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

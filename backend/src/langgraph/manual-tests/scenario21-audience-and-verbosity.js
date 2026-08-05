const {
  detectCollectionVerbosity,
  getFixedProductAnswer,
  MAX_COLLECTION_QUESTION_LENGTH,
} = require('../nodes/askNextQuestion');
const { isMaleUser, MALE_FREE_ONLY_MESSAGE } = require('../nodes/askServiceChoice');

async function main() {
  const messages = [
    { role: 'human', content: '我想增肌，你能帮到我吗？我是男生' },
  ];
  if (!isMaleUser(messages)) throw new Error('没有识别男性用户的主动声明');
  if (!isMaleUser([{ role: 'human', content: '你好我要减脂，我是校男大学生可以吗' }])) {
    throw new Error('没有识别复合消息里的男大学生表达');
  }

  const boundary = getFixedProductAnswer(messages[0].content);
  if (!boundary || !boundary.includes('暂时不会进入长期跟踪调整')) {
    throw new Error('男性用户没有收到准确的长期服务边界');
  }
  if (!MALE_FREE_ONLY_MESSAGE.includes('第一版基础方案')) {
    throw new Error('免费路径没有保留第一版基础方案');
  }

  const verboseText =
    '好嘞，我先来详细了解一下你的各种情况，因为不同的人平时吃饭会有很多不同，而每一种生活方式也会影响后面的安排，' +
    '所以我们需要慢慢聊清楚。像食堂、外卖、自己做饭都有不同特点，我也能针对每一种情况认真分析并给出很多帮助。' +
    '除此之外，口味、预算和运动也很重要，不过我们现在先从第一个问题开始，你平时主要吃食堂还是外卖呀？';
  if (verboseText.length <= MAX_COLLECTION_QUESTION_LENGTH) throw new Error('测试文本不够长');
  const violations = detectCollectionVerbosity(verboseText);
  if (!violations.some((item) => item.type === 'collection_question_too_verbose')) {
    throw new Error('没有拦截啰嗦的采集回复');
  }

  console.log('✅ 男性用户仍可获得免费问答和第一版方案，但不会进入长期调整');
  console.log('✅ 采集阶段超过长度上限的重复铺垫会触发重新生成');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

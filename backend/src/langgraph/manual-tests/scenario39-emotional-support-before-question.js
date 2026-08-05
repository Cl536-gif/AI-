const {
  provideEmotionalSupport,
  classifyEmotionalContext,
  buildEmotionalSupportMessage,
} = require('../nodes/provideEmotionalSupport');

async function main() {
  const cases = [
    ['我好焦虑，我要减肥', 'general_anxiety'],
    ['我真的坚持不下去了', 'persistence_distress'],
    ['最近身材焦虑特别严重', 'appearance_anxiety'],
    ['刚才吃多了特别自责', 'eating_guilt'],
  ];
  cases.forEach(([text, expected]) => {
    const actual = classifyEmotionalContext(text);
    if (actual !== expected) throw new Error(`${text} 分类错误: ${actual}`);
    const reply = buildEmotionalSupportMessage(actual);
    if (!reply || reply.length > 115) throw new Error(`${expected} 支持话术缺失或过长`);
  });

  const firstTurn = await provideEmotionalSupport({
    messages: [{ role: 'human', content: '我好焦虑，我要减肥' }],
  });
  if (firstTurn.messages?.length !== 2) throw new Error('首次情绪表达没有按身份介绍和情绪支持拆成两条');
  if (!firstTurn.messages[0].content.startsWith('你好～我是你的私人健康饮食管理秘书')) {
    throw new Error('首次对话没有先介绍秘书身份');
  }
  if (!firstTurn.messages[1].content.includes('焦虑') || !firstTurn.messages[1].content.includes('陪你一起')) {
    throw new Error('焦虑回应缺少共情或共同解决表达');
  }

  const ordinary = await provideEmotionalSupport({
    messages: [{ role: 'human', content: '我平时在食堂吃饭' }],
  });
  if (ordinary.messages) throw new Error('普通饮食回答被过度套用情绪话术');

  console.log('✅ 焦虑、坚持困难、容貌身材焦虑和进食自责均能识别');
  console.log('✅ 首次对话顺序为身份介绍、共情与办法、后续问题');
  console.log('✅ 普通回答不会被过度共情或增加啰嗦话术');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

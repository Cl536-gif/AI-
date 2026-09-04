const {
  provideEmotionalSupport,
  buildEmotionalSupportMessage,
} = require('../nodes/provideEmotionalSupport');

function countPersistenceSupport(messages) {
  const expected = buildEmotionalSupportMessage('persistence_distress');
  return (messages || []).filter((message) => message.content === expected).length;
}

async function main() {
  const ordinaryTurn = await provideEmotionalSupport({
    messages: [
      { role: 'human', content: '我平时吃食堂' },
      { role: 'ai', content: '你喜欢什么口味？' },
      { role: 'human', content: '坚持不下去了' },
    ],
  });
  if (ordinaryTurn.messages?.length !== 1) throw new Error('普通轮次不是单条共情回复');
  if (countPersistenceSupport(ordinaryTurn.messages) !== 1) throw new Error('普通轮次共情气泡数不是1');

  const firstTurn = await provideEmotionalSupport({
    messages: [{ role: 'human', content: '坚持不下去了' }],
  });
  if (firstTurn.messages?.length !== 2) throw new Error('首轮没有保留独立身份介绍气泡');
  if (countPersistenceSupport(firstTurn.messages) !== 1) throw new Error('首轮共情气泡数不是1');

  const allText = firstTurn.messages.concat(ordinaryTurn.messages).map((message) => message.content).join('\n');
  if (/抱抱/.test(allText)) throw new Error('坚持困难话术仍包含“抱抱”');
  if (buildEmotionalSupportMessage('persistence_distress').length > 65) {
    throw new Error('坚持困难话术仍然过长');
  }

  console.log('✅ 普通轮次仅一个共情气泡，首轮保留独立介绍且共情气泡仍为1');
  console.log('✅ 坚持困难话术已缩短，不含“抱抱”');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

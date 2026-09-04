const { stripPrematureKnownSlotsSummary } = require('../nodes/askNextQuestion');

async function main() {
  const cases = [
    [
      '好，记下了：\n就餐场景（食堂/外卖）：食堂\n口味偏好：偏辣\n预算（每顿）：30元\n接下来聊聊运动：你平时会做什么运动呀？',
      '接下来聊聊运动：你平时会做什么运动呀？',
    ],
    ['收到～最后了解一下日常活动：你平时运动吗？', '最后了解一下日常活动：你平时运动吗？'],
    [
      '好嘾，预算15元一餐、不吃牛肉，这两点都记下啦～\n\n那最后一个小问题：最近有在运动吗？',
      '那最后一个小问题：最近有在运动吗？',
    ],
  ];
  for (const [input, expected] of cases) {
    const actual = stripPrematureKnownSlotsSummary(input);
    if (actual !== expected) throw new Error(`清理结果不符合预期：${actual}`);
  }

  const natural = '你说喜欢辣口我记住了，一顿饭的预算大概是多少呀？';
  if (stripPrematureKnownSlotsSummary(natural) !== natural) throw new Error('自然承接句被误删');
  const startsWithHao = '好奇你平时更喜欢什么口味？';
  if (stripPrematureKnownSlotsSummary(startsWithHao) !== startsWithHao) throw new Error('“好奇”被误当成机械开场');

  console.log('✅ 已清理所有槽位前的机械“记下了”和已知信息列表');
  console.log('✅ 普通的自然承接句保留');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

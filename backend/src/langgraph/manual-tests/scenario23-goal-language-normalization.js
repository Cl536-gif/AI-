const { normalizeGoalFromContext } = require('../nodes/extractSlots');

function normalize(userText, lastAskedSlot = 'goal', extractedValue = null) {
  return normalizeGoalFromContext({ userText, lastAskedSlot, extractedValue });
}

function main() {
  if (normalize('精气神') !== '希望更有精气神') throw new Error('没有识别“精气神”');
  if (normalize('不犯困') !== '希望精力更稳定、不容易犯困') throw new Error('没有识别“不犯困”');
  if (normalize('薄肌线条') !== '薄肌线条') throw new Error('未知但有效的新表达没有保留原话');
  if (normalize('不知道') !== null) throw new Error('把无实际目标的回答误存成目标');
  if (normalize('精气神', 'budget') !== null) throw new Error('脱离目标提问语境后仍然硬猜字段');

  console.log('✅ “精气神”等常见状态表达能规范化为goal');
  console.log('✅ 未收录但有意义的短回答按上下文保留原话');
  console.log('✅ 无目标回答和无目标语境不会被误存');
}

try {
  main();
} catch (err) {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
}

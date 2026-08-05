const { detectFormatViolations } = require('../../services/formatGuard');
const { sanitizeUserVisibleReply } = require('../../routes/chatLanggraph');

function main() {
  const violations = detectFormatViolations('不好意思，刚才有点跑偏了——回到问题。');
  if (!violations.some((item) => item.type === 'robotic_dash')) {
    throw new Error('格式检查没有拦截破折号');
  }

  const cleaned = sanitizeUserVisibleReply('回到正题——继续问一下---你的就餐场景。');
  if (/[—]|---/.test(cleaned)) throw new Error('接口最终输出仍含人机式横线符号');
  if (!cleaned.includes('回到正题，继续问一下，你的就餐场景')) {
    throw new Error('清理符号后破坏了原句');
  }

  const chineseOnly = sanitizeUserVisibleReply('这个方案完全OK，由AI继续调整');
  if (/[A-Za-z]/.test(chineseOnly) || !chineseOnly.includes('完全可以')) {
    throw new Error(`接口中文化兜底失败: ${chineseOnly}`);
  }

  console.log('✅ 格式检查会拦截破折号和连续横线');
  console.log('✅ 接口发送前还有确定性清理兜底');
  console.log('✅ 接口发送前会把残留英文转为中文或清理');
}

try {
  main();
} catch (err) {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
}

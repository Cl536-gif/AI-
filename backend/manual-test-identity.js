// 手动测试脚本（需要真实网络访问 DashScope，云端沙箱环境跑不了）
// 验证"AI秘书"改成"饮食秘书"之后：
// 1. 用户直接问"你是谁"时，AI怎么介绍自己
// 2. 首次触发认可铁律（第19条）开场时，有没有夹带"AI"这两个字母
//
// 运行：cd backend && node manual-test-identity.js
const localChatService = require('./src/services/localChatService');

function checkForAI(text) {
  return /\bAI\b/i.test(text) || text.includes('AI');
}

async function main() {
  console.log('=== 场景A：用户直接问"你是谁" ===');
  const resultA = await localChatService.sendLocalChatMessage({ message: '你是谁', history: [] });
  console.log(resultA.reply);
  console.log('是否出现"AI"字样:', checkForAI(resultA.reply) ? '是（有问题）' : '否（符合预期）');

  console.log('\n=== 场景B：首次触发认可铁律开场（"我想减脂"） ===');
  const resultB = await localChatService.sendLocalChatMessage({ message: '我想减脂', history: [] });
  console.log(resultB.reply);
  console.log('是否出现"AI"字样:', checkForAI(resultB.reply) ? '是（有问题）' : '否（符合预期）');

  console.log('\n--- 预期：两处回复都应该用"饮食秘书"这类自然表述介绍/呼应，' +
    '完全不出现"AI"这两个英文字母 ---');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

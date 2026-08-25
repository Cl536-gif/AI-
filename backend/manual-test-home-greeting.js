const assert = require('assert');
const {
  buildGreetingMessages,
  classifyPrivacyOnboardingMessage,
  handlePrivacyOnboardingMessage,
  FIRST_VISIT_GREETING_MESSAGES,
} = require('./src/services/chatService');

function countWave(text) {
  return (text.match(/～/g) || []).length;
}

async function main() {
  const first = buildGreetingMessages(null);
  assert.deepEqual(first, FIRST_VISIT_GREETING_MESSAGES);
  assert.equal(first.length, 4);
  assert.match(first[0], /减脂变得更轻松、更生活化/);
  assert.doesNotMatch(first.join(''), /不折腾/);
  assert.match(first[1], /先问几个简单的饮食问题/);
  assert.match(first[2], /征得你的同意/);
  assert.match(first[3], /回复“1”/);
  assert.match(first[3], /回复“2”或“继续”/);
  assert.equal(countWave(first.join('')), 1);

  const recent = buildGreetingMessages('2026-08-06T01:00:00.000Z', Date.parse('2026-08-06T02:00:00.000Z'));
  assert.deepEqual(recent, [
    '欢迎回来哈～',
    '有新的饮食情况或想问的问题，直接告诉我，我们接着聊。',
  ]);
  assert.ok(countWave(recent.join('')) <= 1);

  const returning = buildGreetingMessages('2026-08-01T01:00:00.000Z', Date.parse('2026-08-06T02:00:00.000Z'));
  assert.equal(returning[0], '宝子回来啦～');
  assert.ok(countWave(returning.join('')) <= 1);

  assert.equal(classifyPrivacyOnboardingMessage('我想看看具体的隐私条款'), 'policy');
  assert.equal(classifyPrivacyOnboardingMessage('隐私政策'), 'policy');
  assert.equal(classifyPrivacyOnboardingMessage('我想看隐私正策'), 'policy');
  assert.equal(classifyPrivacyOnboardingMessage('把隐思条款发给我'), 'policy');
  assert.equal(classifyPrivacyOnboardingMessage('没有问题'), 'continue');
  assert.equal(classifyPrivacyOnboardingMessage('继续'), 'continue');
  assert.equal(classifyPrivacyOnboardingMessage('没有问题，继续'), 'continue');
  assert.equal(classifyPrivacyOnboardingMessage('好吧'), 'continue');
  assert.equal(classifyPrivacyOnboardingMessage('OK'), 'continue');
  assert.equal(classifyPrivacyOnboardingMessage('1'), 'policy');
  assert.equal(classifyPrivacyOnboardingMessage('2'), 'continue');

  const userId = `privacy-test-${Date.now()}`;
  // getGreeting 会为首次访问者进入隐私说明等待状态。
  const chatService = require('./src/services/chatService');
  await chatService.getGreeting({ userId });
  const policy = handlePrivacyOnboardingMessage(userId, '我想了解隐私政策');
  assert.equal(policy.replies.length, 2);
  assert.match(policy.replies[0], /1\. 收集范围/);
  assert.match(policy.replies[1], /回复“2”或“继续”/);
  const continued = handlePrivacyOnboardingMessage(userId, '2');
  assert.match(continued.reply, /主要吃食堂还是点外卖/);
  assert.equal(continued.replies.length, 2);
  assert.match(continued.replies[0], /随时对我说“隐私政策”/);
  assert.match(continued.replies[1], /主要吃食堂还是点外卖/);
  assert.equal(continued.nextRoute, 'langgraph');

  console.log('PASS: 首页开场解释提问原因与隐私，查看条款后等待用户继续，再开始饮食收集');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

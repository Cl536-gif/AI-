// 不调用模型的确定性回归测试：覆盖真实页面复现出的三类问题。
const { normalizeRestrictionFromContext } = require('../nodes/extractSlots');
const { mergeRestrictionReaction } = require('../nodes/conflictRouter');
const { detectAskNextQuestionViolations } = require('../nodes/askNextQuestion');
const { buildServiceBoundaryAnswer } = require('../../pricingConfig');

async function main() {
  const foods = normalizeRestrictionFromContext({
    userText: '芝士花生',
    lastAskedSlot: 'restrictions',
    extractedValue: null,
  });
  if (foods !== '需要避开芝士花生') throw new Error(`短食物回答补全失败: ${foods}`);

  const mixedIntent = normalizeRestrictionFromContext({
    userText: '你需要付费吗芝士花生',
    lastAskedSlot: 'restrictions',
    extractedValue: null,
  });
  if (mixedIntent !== '需要避开芝士花生') throw new Error(`收费问题+食物回答拆分失败: ${mixedIntent}`);

  const merged = mergeRestrictionReaction('需要避开芝士和花生', '拉肚子', '拉肚子');
  if (merged !== '需要避开芝士和花生，吃后会拉肚子') throw new Error(`食物与反应合并失败: ${merged}`);

  const goalReply =
    '那最后再问一个：你希望调整饮食后，整体达到什么样的状态？比如穿衣服更合身，想到哪说哪就行～';
  const goalViolations = await detectAskNextQuestionViolations(goalReply, '身材目标', 'goal');
  if (goalViolations.some((v) => v.type === 'not_asking_target_slot')) {
    throw new Error('明确的身材目标问句仍被误判为没有问到目标');
  }

  const productAnswer = buildServiceBoundaryAnswer();
  if (productAnswer.includes('所有饮食建议都是免费的')) {
    throw new Error('产品固定话术仍错误宣称所有饮食建议免费');
  }

  console.log('✅ 简短食物回答按忌口上下文补全');
  console.log('✅ 收费问题与同句食物回答成功拆分');
  console.log('✅ 后续症状与既有食物合并保存');
  console.log('✅ 明确的身材目标问句不再被质检器误杀');
  console.log('✅ 收费回答使用准确的确定性产品边界');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

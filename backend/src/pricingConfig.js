// 客观定价事实只保存在 pricingConfig.json；本文件负责校验配置并生成
// 确定性文案，不在代码或提示词中重复写死价格。
const rawConfig = require('./pricingConfig.json');

function readPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}必须是正整数`);
  }
  return value;
}

function readPositivePrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('pushService.priceCny必须是有限正数');
  }
  return value;
}

if (!rawConfig || !rawConfig.pushService || rawConfig.pushService.currency !== 'CNY') {
  throw new TypeError('pricingConfig.json必须提供CNY计价的pushService配置');
}

const pushService = Object.freeze({
  trialDays: readPositiveInteger(rawConfig.pushService.trialDays, 'pushService.trialDays'),
  billingCycleDays: readPositiveInteger(
    rawConfig.pushService.billingCycleDays,
    'pushService.billingCycleDays'
  ),
  priceCny: readPositivePrice(rawConfig.pushService.priceCny),
  currency: 'CNY',
});

function buildPushServiceClause() {
  return (
    `这部分有${pushService.trialDays}天免费试用，` +
    `之后每${pushService.billingCycleDays}天收费${pushService.priceCny}元。`
  );
}

function buildServiceBoundaryAnswer() {
  return (
    '基础档案、科学饮食问答和第一版方案是免费的；长期规划服务包含持续更新的长期档案、定期跟进和阶段性方案调整。' +
    buildPushServiceClause()
  );
}

function buildReminderCapabilityAnswer() {
  return (
    '可以，如果你选择长期规划服务，我会按照你设定的频率和时间提醒，并结合记录做阶段性调整；' +
    '免费的科学饮食问答不会主动推送提醒。'
  );
}

module.exports = {
  pushService,
  buildPushServiceClause,
  buildServiceBoundaryAnswer,
  buildReminderCapabilityAnswer,
};

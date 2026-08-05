// 推送服务定价配置：定价策略还没最终确定，priceDisplay 先留 null 占位。
// askServiceChoice.js 里的服务边界话术调用 buildPushServiceClause() 来
// 动态生成价格这一句，以后调价/改试用期只需要改这个文件，不用动话术
// 本身的措辞。
const pushService = {
  trialDays: 14,
  billingCycleDays: 14,
  // 定价没定下来之前保持 null；定下来后填类似 "9.9元" 这样的字符串
  priceDisplay: null,
};

function buildPushServiceClause() {
  const priceClause = pushService.priceDisplay
    ? `之后按每${pushService.billingCycleDays}天为一个周期，收费${pushService.priceDisplay}`
    : `之后按每${pushService.billingCycleDays}天为一个周期付费（具体价格还在制定中，定下来第一时间告诉你）`;
  return `这部分有${pushService.trialDays}天免费试用，${priceClause}。`;
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

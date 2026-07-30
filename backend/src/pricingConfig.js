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

module.exports = { pushService, buildPushServiceClause };

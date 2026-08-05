const {
  resolveBodyOnboarding,
  missingRequiredFields,
  validateBodyProfile,
  findImplausibleBodyValue,
} = require('../nodes/resolveBodyOnboarding');

async function main() {
  const valid = validateBodyProfile({ ageYears: 20, heightCm: 165, currentWeightKg: 55 });
  if (missingRequiredFields(valid).length !== 0) throw new Error('完整基础数据仍被判断为缺失');

  const invalid = validateBodyProfile({ ageYears: 8, heightCm: 20, currentWeightKg: 500 });
  if (missingRequiredFields(invalid).length !== 2) throw new Error('无效年龄和身高没有被拦截');
  if (!findImplausibleBodyValue(invalid)?.includes('500公斤')) {
    throw new Error('极端体重没有进入显式确认流程');
  }

  const skipped = await resolveBodyOnboarding({
    messages: [{ role: 'human', content: '暂时不方便，先跳过' }],
    bodyProfile: {},
    pendingBodyOnboarding: { askedCount: 1 },
  });
  if (skipped.bodyOnboardingStatus !== 'declined') throw new Error('身体数据跳过状态错误');
  if (skipped.cycleOnboardingStatus !== 'asked' || !skipped.pendingCycleOnboarding) {
    throw new Error('身体数据结束后没有进入经期询问');
  }
  if (skipped.messages.length !== 2) throw new Error('没有把身体数据回应和经期问题分成两条消息');

  console.log('✅ 无效年龄/身高会丢弃，极端体重会保留并要求确认');
  console.log('✅ 身体数据采集位于经期询问之前');
  console.log('✅ 两个阶段使用两条独立消息');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

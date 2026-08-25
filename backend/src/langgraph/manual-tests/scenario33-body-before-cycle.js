const {
  resolveBodyOnboarding,
  missingRequiredFields,
  validateBodyProfile,
  findImplausibleBodyValue,
} = require('../nodes/resolveBodyOnboarding');

async function main() {
  const valid = validateBodyProfile({
    ageYears: 20,
    heightCm: 165,
    currentWeightKg: 55,
    dailyActivity: '上课久坐为主',
  });
  if (missingRequiredFields(valid).length !== 0) throw new Error('完整基础数据仍被判断为缺失');

  const invalid = validateBodyProfile({ ageYears: 8, heightCm: 20, currentWeightKg: 500 });
  if (missingRequiredFields(invalid).length !== 3) throw new Error('无效年龄、身高和缺失的活动情况没有被拦截');
  if (!findImplausibleBodyValue(invalid)?.includes('500公斤')) {
    throw new Error('极端体重没有进入显式确认流程');
  }

  const skipped = await resolveBodyOnboarding({
    messages: [{ role: 'human', content: '暂时不方便，先跳过' }],
    bodyProfile: {},
    pendingBodyOnboarding: { askedCount: 1 },
  });
  if (skipped.bodyOnboardingStatus !== 'required_missing') throw new Error('身体数据跳过状态错误');
  if (skipped.cycleOnboardingStatus === 'asked' || skipped.pendingCycleOnboarding) {
    throw new Error('长期规划必需的身体数据缺失时仍提前进入经期询问');
  }
  if (skipped.messages.length !== 1 || !skipped.messages[0].content.includes('不会启动长期方案')) {
    throw new Error('身体数据缺失时没有说明长期方案尚未启动');
  }

  console.log('✅ 无效年龄/身高会丢弃，极端体重会保留并要求确认');
  console.log('✅ 身体数据采集位于经期询问之前，缺失时不会提前进入下一阶段');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

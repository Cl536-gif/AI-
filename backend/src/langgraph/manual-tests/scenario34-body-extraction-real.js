const { resolveBodyOnboarding } = require('../nodes/resolveBodyOnboarding');

async function main() {
  const result = await resolveBodyOnboarding({
    messages: [{ role: 'human', content: '20岁，165cm，现在55公斤，目标50公斤，平时上课久坐比较多，最近一个月没怎么变' }],
    bodyProfile: {},
    pendingBodyOnboarding: { askedCount: 1 },
  });

  const profile = result.bodyProfile || {};
  if (profile.ageYears !== 20 || profile.heightCm !== 165 || profile.currentWeightKg !== 55) {
    throw new Error(`基础身体数据提取错误: ${JSON.stringify(profile)}`);
  }
  if (profile.targetWeightKg !== 50 || !profile.dailyActivity?.includes('久坐')) {
    throw new Error(`可选计算信息提取错误: ${JSON.stringify(profile)}`);
  }
  if (result.bodyOnboardingStatus !== 'completed') throw new Error('身体数据齐全后没有完成该阶段');
  if (result.cycleOnboardingStatus !== 'asked' || result.messages.length !== 2) {
    throw new Error('没有在身体数据确认后用独立消息询问经期');
  }

  console.log(`✅ 真实身体数据提取: ${JSON.stringify(profile)}`);
  console.log('✅ 完成身体数据后再单独询问经期');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

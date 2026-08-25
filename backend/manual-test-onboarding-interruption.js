const { resolveServiceChoice } = require('./src/langgraph/nodes/resolveServiceChoice');
const { resolveBodyOnboarding } = require('./src/langgraph/nodes/resolveBodyOnboarding');
const { routeAfterServiceChoice } = require('./src/langgraph/graph');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const earlyBody = await resolveServiceChoice({
    messages: [{ role: 'human', content: '22岁，165厘米，120斤' }],
    pendingServiceChoice: { stage: 'schedule', askedCount: 1 },
    bodyProfile: {},
  });
  assert(earlyBody.bodyProfile.ageYears === 22, '等待提醒时丢失年龄');
  assert(earlyBody.bodyProfile.heightCm === 165, '等待提醒时丢失身高');
  assert(earlyBody.bodyProfile.currentWeightKg === 60, '等待提醒时没有把120斤换成60公斤');
  assert(earlyBody.pendingServiceChoice.deferred, '保存提前回答后仍立刻重复追问提醒');
  assert(routeAfterServiceChoice(earlyBody) === '__end__', '保存提前回答后仍自动输出下一段问题');

  const pausedSchedule = await resolveServiceChoice({
    messages: [{ role: 'human', content: '我现在有点忙，晚点再继续建档' }],
    pendingServiceChoice: { stage: 'schedule', askedCount: 1 },
  });
  assert(pausedSchedule.pendingServiceChoice === null, '提醒阶段暂停后没有结束提醒子步骤');
  assert(pausedSchedule.serviceTier === 'subscribed', '暂停后没有保留用户已经选择的长期模式');
  assert(pausedSchedule.pendingBodyOnboarding?.paused, '暂停后没有建立可续填的身体资料断点');
  assert(routeAfterServiceChoice(pausedSchedule) === 'generatePlan', '暂停后应先给用户第一份当餐方案');
  assert(/今天有空/.test(pausedSchedule.messages[0].content), '暂停回复没有提醒当天回来继续');
  assert(!/年龄|身高|体重/.test(pausedSchedule.messages[0].content), '暂停后仍立刻抛出下一段身体问题');

  const pausedBody = await resolveBodyOnboarding({
    messages: [{ role: 'human', content: '我现在有点忙，晚点再继续建档' }],
    pendingBodyOnboarding: { stage: 'collecting', askedCount: 1 },
    bodyProfile: { ageYears: 22, heightCm: 165, currentWeightKg: 60 },
  });
  assert(pausedBody.pendingBodyOnboarding.paused, '身体资料阶段没有进入暂停状态');
  const resumedBody = await resolveBodyOnboarding({
    messages: [{ role: 'human', content: '继续建档' }],
    pendingBodyOnboarding: pausedBody.pendingBodyOnboarding,
    bodyProfile: { ageYears: 22, heightCm: 165, currentWeightKg: 60 },
  });
  assert(/平时活动情况/.test(resumedBody.messages[0].content), '回来后没有只追问剩余字段');
  assert(!/年龄|身高|当前体重/.test(resumedBody.messages[0].content), '回来后重复询问已保存字段');

  console.log('✅ 等待提醒时也会保存同一条消息里的年龄、身高和体重');
  console.log('✅ 用户说晚点继续后会暂停，不会立刻抛出下一段问题');
  console.log('✅ 用户回来后从缺失字段续填，已回答内容不用重填');
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});

const { createInitialSlots } = require('./src/langgraph/state');
const {
  routeEntry,
  shouldRouteReturningUserToFollowUp,
} = require('./src/langgraph/graph');
const { provideEmotionalSupport } = require('./src/langgraph/nodes/provideEmotionalSupport');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function knownProfileContext() {
  return {
    accessMode: 'basic_profile_only',
    serviceStatus: 'onboarding_incomplete',
    profile: {
      profileVersion: 3,
      profile: {
        body: { ageYears: 22, heightCm: 165, currentWeightKg: 60 },
        diet: { scene: 'cafeteria', cafeteriaMode: 'self_select' },
      },
    },
  };
}

async function main() {
  const returningState = {
    messages: [{ role: 'human', content: '我回来啦，今天午餐怎么吃？' }],
    slots: createInitialSlots(),
    longTermContext: knownProfileContext(),
  };
  assert(shouldRouteReturningUserToFollowUp(returningState), '已有档案的新会话没有被识别为回访');
  assert(routeEntry(returningState) === 'answerFollowUp', '已有档案的新会话仍进入首次六项收集');

  const newUserState = {
    messages: [{ role: 'human', content: '我想减脂' }],
    slots: createInitialSlots(),
    longTermContext: null,
  };
  assert(!shouldRouteReturningUserToFollowUp(newUserState), '真正的新用户被误识别为回访');
  assert(routeEntry(newUserState) === 'extractSlots', '真正的新用户没有进入首次采集');

  const sameOnboardingThread = {
    messages: [
      { role: 'human', content: '我主要吃食堂' },
      { role: 'ai', content: '你们食堂是自选还是套餐？' },
      { role: 'human', content: '自选' },
    ],
    slots: {
      ...createInitialSlots(),
      scene: { value: '食堂', confirmed: true },
    },
    longTermContext: knownProfileContext(),
  };
  assert(!shouldRouteReturningUserToFollowUp(sameOnboardingThread), '首次建档中的同一会话被错误跳出采集流程');
  assert(routeEntry(sameOnboardingThread) === 'extractSlots', '首次建档中的后续回答没有继续采集');

  const emotionalReply = await provideEmotionalSupport({
    messages: [{ role: 'human', content: '我偷吃薯片了，好焦虑' }],
    longTermContext: knownProfileContext(),
  });
  assert(emotionalReply.messages.length === 1, '已有档案的新会话仍发送了首次自我介绍');
  assert(!emotionalReply.messages[0].content.includes('我是你的私人'), '回访回复泄露了首次自我介绍');

  console.log('✅ 已有档案的新thread直接进入回访回答');
  console.log('✅ 真正的新用户仍进入首次六项采集');
  console.log('✅ 首次建档中的同一thread不会被基础档案提前截断');
  console.log('✅ 已有档案的新会话不再发送首次自我介绍');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

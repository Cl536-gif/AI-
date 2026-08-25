const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const { createLongTermEventProcessor } = require('./src/services/longTermEventService');
const {
  createGraphPersistenceCoordinator,
  prepareGraphContext,
  persistGraphTurn,
} = require('./src/services/graphPersistenceCoordinator');
const {
  setUserStore,
  resetUserStore,
} = require('./src/stores/userStoreProvider');
const {
  confirmLongTermProfile,
  activateTrialAfterOfficialPlan,
} = require('./src/services/longTermService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-graph-coordinator-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:88888888-8888-4888-8888-888888888888';
  let extractorCalls = 0;
  const eventProcessor = createLongTermEventProcessor({
    store,
    extractEvents: async (message) => {
      extractorCalls += 1;
      return [{
        eventType: 'meal',
        occurredAt: '2026-08-05T12:00:00+08:00',
        payload: { summary: '午餐吃了米饭', rawText: message },
        source: 'user',
        idempotencyKey: `coordinator:${extractorCalls}`,
      }];
    },
  }).processUserMessage;
  const coordinator = createGraphPersistenceCoordinator({ store, eventProcessor });

  const initialState = {
    serviceTier: 'free',
    slots: {
      scene: { value: '食堂', confirmed: true },
      cafeteriaMode: { value: '自己挑菜', confirmed: true },
      taste: { value: '酸甜', confirmed: true },
      budget: { value: '30元', confirmed: true },
      restrictions: { value: '不吃香菜', confirmed: true },
      goal: { value: '减脂', confirmed: true },
      exercise: { value: '每周跑步两次', confirmed: true },
    },
    bodyProfile: {},
  };
  const freeResult = await coordinator.persistTurn(userId, '中午吃了米饭', 'thread-coordinator', initialState, {
    now: '2026-08-05T12:10:00+08:00',
  });
  assert(freeResult.profilePersistence.status === 'updated', '免费用户基础档案没有写入');
  assert(freeResult.eventPersistence.status === 'not_entitled', '免费用户没有被事件权限阻断');
  assert(extractorCalls === 0, '免费用户调用了长期事件抽取模型');

  const selectedState = { ...initialState, serviceTier: 'subscribed' };
  const selectedResult = await coordinator.persistTurn(userId, '我选择长期', 'thread-coordinator', selectedState, {
    now: '2026-08-05T12:20:00+08:00',
  });
  assert(selectedResult.serviceStatus.status === 'onboarding_incomplete', 'LangGraph长期选择被错误映射为正式订阅');
  assert(selectedResult.serviceStatus.trialStartedAt === null, '选择长期后错误启动14天体验');
  assert(extractorCalls === 0, '建档中用户调用了长期事件抽取模型');

  await confirmLongTermProfile(userId, { store, now: '2026-08-05T13:00:00+08:00' });
  await activateTrialAfterOfficialPlan(userId, 'official-plan-coordinator', {
    store,
    now: '2026-08-05T14:00:00+08:00',
  });
  const activeResult = await coordinator.persistTurn(userId, '午餐吃了一碗米饭', 'thread-coordinator', selectedState, {
    now: '2026-08-05T14:10:00+08:00',
  });
  assert(activeResult.eventPersistence.status === 'recorded', '体验用户没有写入长期事件');
  assert(extractorCalls === 1 && store.listEvents(userId).length === 1, '体验用户事件抽取或落库错误');

  const context = await coordinator.prepareContext(userId, { now: '2026-08-05T14:20:00+08:00' });
  assert(context.accessMode === 'long_term', '路由前没有得到长期上下文');
  assert(context.recentEvents[0].eventType === 'meal', '路由前上下文没有包含最新事件');

  // graphPersistenceCoordinator is imported before the provider is changed,
  // matching server startup. The default coordinator must still use the store
  // selected afterwards instead of retaining the initial SQLite singleton.
  const selectedStore = createUserStore({ dbPath: path.join(tempDir, 'selected.db') });
  const selectedUserId = 'anon:99999999-9999-4999-8999-999999999999';
  selectedStore.ensureUser(selectedUserId);
  selectedStore.updateUserTimezone(selectedUserId, 'Asia/Tokyo');
  setUserStore(selectedStore, { adapterName: 'SelectedAfterModuleLoadStore' });
  const dynamicallySelectedContext = await prepareGraphContext(selectedUserId, {
    now: '2026-08-05T14:20:00+08:00',
  });
  assert(
    dynamicallySelectedContext.temporalContext.timezone === 'Asia/Tokyo',
    '默认协调器缓存了模块加载时的SQLite Store，没有使用随后选择的Provider'
  );
  const dynamicallyPersisted = await persistGraphTurn(
    selectedUserId,
    '今天午餐怎么吃？',
    'thread-dynamic-provider',
    {
      ...initialState,
      messages: [
        { role: 'human', content: '今天午餐怎么吃？' },
        { role: 'assistant', content: '午餐建议主食一拳、蛋白质一掌、蔬菜一到两拳。' },
      ],
    },
    { now: '2026-08-05T14:25:00+08:00' }
  );
  assert(dynamicallyPersisted.advicePersistence.status === 'recorded', '动态Provider没有记录建议');
  assert(
    selectedStore.listAdviceHistory(selectedUserId).length === 1,
    '动态Provider响应显示recorded，但所选Store没有建议记录'
  );
  resetUserStore();
  selectedStore.close();

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 路由生命周期写入基础档案并为免费用户阻断长期事件');
  console.log('✅ LangGraph的subscribed只映射为建档中，不会伪造付费或启动体验');
  console.log('✅ 体验开始后用户消息才进入事件抽取与写入链');
  console.log('✅ 下一轮请求前能够读取授权范围内的长期上下文');
  console.log('✅ 默认协调器在请求时解析随后选择的Provider，上下文与建议写入不再缓存启动期SQLite Store');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

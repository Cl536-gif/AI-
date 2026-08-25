const {
  startPlanRevision,
  createResolvePlanRevision,
} = require('../nodes/resolvePlanRevision');
const { graph } = require('../graph');

function assert(condition, message) { if (!condition) throw new Error(message); }

function fakeExtractor(results) {
  let index = 0;
  return {
    async invoke() {
      const result = results[index];
      index += 1;
      return result;
    },
  };
}

async function main() {
  const routed = await graph.invoke({
    messages: [{ role: 'human', content: '我想按现在的情况重新调整方案' }],
    longTermContext: {
      accessMode: 'long_term',
      pausedPlan: { planId: 'plan-route-v1', planVersion: 1, plan: { stageLabel: '第一阶段' } },
    },
    initialPlanDelivered: true,
  });
  assert(routed.pendingPlanRevision?.stage === 'collect_changes', '图入口没有把明确重做请求路由到专用节点');
  assert(routed.pendingPlanRevision.parentPlanId === 'plan-route-v1', '图路由后丢失暂停计划关联');

  const started = startPlanRevision({
    longTermContext: {
      pausedPlan: { planId: 'plan-v1', planVersion: 1, plan: { stageLabel: '第一阶段' } },
    },
  });
  assert(started.pendingPlanRevision.stage === 'collect_changes', '没有进入变化收集状态');
  assert(started.messages[0].content.includes('一次把想到的都告诉我'), '没有提示用户可一次提供多项变化');

  const resolve = createResolvePlanRevision({
    extractor: fakeExtractor([
      {
        changes: [
          { field: 'schedule', summary: '新学期午休提前半小时' },
          { field: 'activity_level', summary: '现在每周跑步三次' },
        ],
        needsMoreDetail: false,
        followUpQuestion: null,
      },
      {
        changes: [{ field: 'food_preference', summary: '最近不想吃鸡胸肉' }],
        needsMoreDetail: false,
        followUpQuestion: null,
      },
    ]),
  });
  const collected = await resolve({
    messages: [{ role: 'human', content: '新学期午休提前了半小时，而且我现在每周跑三次' }],
    pendingPlanRevision: started.pendingPlanRevision,
  });
  assert(collected.pendingPlanRevision.changes.length === 2, '一句话里的多项变化没有全部收集');
  assert(collected.messages[0].content.includes('1.') && collected.messages[0].content.includes('2.'), '变化清单没有清晰编号');

  const supplemented = await resolve({
    messages: [{ role: 'human', content: '还漏了，我最近不想吃鸡胸肉' }],
    pendingPlanRevision: collected.pendingPlanRevision,
  });
  assert(supplemented.pendingPlanRevision.changes.length === 3, '确认阶段补充信息覆盖或丢失了旧变化');
  assert(supplemented.pendingPlanRevision.stage === 'confirm_changes', '补充后没有重新给确认清单');

  const confirmed = await resolve({
    messages: [{ role: 'human', content: '确认' }],
    pendingPlanRevision: supplemented.pendingPlanRevision,
  });
  assert(confirmed.pendingPlanRevision === null, '确认后仍停留在收集状态');
  assert(confirmed.confirmedPlanRevisionRequest.changes.length === 3, '确认请求没有保存完整变化');
  assert(confirmed.confirmedPlanRevisionRequest.parentPlanId === 'plan-v1', '确认请求丢失上一版本关联');

  const unresolved = createResolvePlanRevision({
    extractor: fakeExtractor([{ changes: [], needsMoreDetail: true, followUpQuestion: '具体是哪方面变了呢？' }]),
  });
  const retry = await unresolved({
    messages: [{ role: 'human', content: '反正就是变了' }],
    pendingPlanRevision: started.pendingPlanRevision,
  });
  assert(retry.pendingPlanRevision.stage === 'collect_changes', '含糊变化被错误确认');
  assert(retry.messages[0].content === '具体是哪方面变了呢？', '没有只追问缺失细节');

  console.log('✅ 用户选择重做后进入独立的变化收集状态');
  console.log('✅ LangGraph入口能识别明确重做请求并路由到专用节点');
  console.log('✅ 一条消息中的多项持续变化会逐项提取并编号确认');
  console.log('✅ 确认阶段可以继续补充，按字段合并且不丢旧信息');
  console.log('✅ 含糊信息只追问缺失点，明确确认后才形成新版请求');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

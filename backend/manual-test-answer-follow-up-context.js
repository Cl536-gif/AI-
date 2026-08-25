const {
  answerFollowUp,
  MAX_CONTEXT_CHARS,
  buildFollowUpContextMessage,
} = require('./src/langgraph/nodes/answerFollowUp');
const {
  routeEntry,
  shouldRouteReturningUserToFollowUp,
} = require('./src/langgraph/graph');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeContext() {
  return {
    userId: 'anon:should-never-reach-model',
    accessMode: 'long_term',
    temporalContext: {
      timezone: 'Asia/Shanghai', localDate: '2026-08-07',
      weekday: '星期五', localTime: '15:00:00',
    },
    profile: {
      profileVersion: 3,
      profile: {
        body: { ageYears: 22, heightCm: 165, currentWeightKg: 60, dailyActivity: '久坐' },
        diet: {
          scene: 'cafeteria', cafeteriaMode: 'self_select', budgetCnyPerMeal: 30,
          tastePreferences: ['酸甜'], restrictions: ['酸奶会腹泻'], goals: ['减脂'],
          exerciseBaseline: '每周跑步两次',
        },
      },
    },
    activePlan: {
      planId: 'private-plan-id',
      plan: {
        stageLabel: '第一阶段', objective: '建立规律饮食结构', durationDays: 14,
        mealGuidance: [{ mealType: 'lunch', guidance: '一份主食、一份蛋白质和一份蔬菜。' }],
        adjustmentRules: ['用户主动反馈额外运动后再调整'],
      },
    },
    pausedPlan: null,
    latestEnergyCalculation: {
      calculationId: 'private-calculation-id',
      formulaId: 'private-formula-id',
      sourceRefs: ['https://internal.example.test'],
      outputs: { estimatedBmrKcalPerDay: 1376, estimatedTeeKcalPerDay: 2064 },
      createdAt: '2026-08-05T09:00:00+08:00',
    },
    recentEvents: [
      { eventId: 'private-event-2', eventType: 'check_in', occurredAt: '2026-08-05T19:00:00+08:00', payload: { summary: '晚餐后饱腹感合适', rawText: '不应出现的原话' } },
      { eventId: 'private-event-1', eventType: 'exercise', occurredAt: '2026-08-05T18:00:00+08:00', payload: { summary: '跑步30分钟' } },
    ],
  };
}

async function main() {
  assert(buildFollowUpContextMessage(null) === null, '空上下文不应注入提示词');
  const timeOnlyMessage = buildFollowUpContextMessage({
    accessMode: 'basic_profile_only',
    temporalContext: makeContext().temporalContext,
  });
  assert(timeOnlyMessage?.content.includes('星期五'), '没有档案时仍应提供确定性当前时间');
  assert(timeOnlyMessage.content.includes('没有任何已确认档案'), '空档案上下文没有明确禁止伪记忆');
  assert(!timeOnlyMessage.content.includes('这是已经建立过档案'), '空档案被错误标记为回访用户');

  const message = buildFollowUpContextMessage(makeContext());
  assert(message?.role === 'system', '长期上下文没有生成独立系统消息');
  assert(message.content.length <= MAX_CONTEXT_CHARS + 500, '长期上下文摘要没有限制长度');
  for (const forbidden of ['should-never-reach-model', 'private-plan-id', 'private-calculation-id', 'private-event-1', 'rawText', '不应出现的原话', 'sourceRefs']) {
    assert(!message.content.includes(forbidden), `长期上下文泄露内部字段: ${forbidden}`);
  }
  assert(
    message.content.indexOf('晚餐后饱腹感合适') < message.content.indexOf('跑步30分钟'),
    '近期事件顺序没有保持业务层提供的新到旧顺序'
  );

  let capturedMessages = null;
  const fakeModel = {
    async invoke(messages) {
      capturedMessages = messages;
      return { content: '可以，今天有额外跑步的话，我会结合你的实际饥饿感微调这一餐。' };
    },
  };
  const result = await answerFollowUp({
    messages: [{ role: 'human', content: '我今天跑步了，晚餐怎么调整？' }],
    longTermContext: makeContext(),
  }, { chatModel: fakeModel });
  assert(result.messages[0].content.includes('微调'), '没有返回模型生成的追问答复');
  assert(capturedMessages.length === 4, '长期用户没有额外注入一条上下文消息');
  assert(capturedMessages[2].content.includes('建立规律饮食结构'), '模型没有收到当前阶段计划摘要');

  capturedMessages = null;
  await answerFollowUp({
    messages: [{ role: 'human', content: '晚餐怎么调整？' }],
    longTermContext: {
      accessMode: 'basic_profile_only',
      serviceStatus: 'onboarding_incomplete',
      profile: makeContext().profile,
      activePlan: { plan: { objective: '不应提供给基础档案用户' } },
      recentEvents: [{ eventType: 'meal', payload: { summary: '不应提供的事件' } }],
    },
  }, { chatModel: fakeModel });
  assert(capturedMessages.length === 4, '已有基础档案的新会话没有注入最小上下文');
  assert(capturedMessages[2].content.includes('165'), '基础档案没有提供给回访回复');
  assert(!capturedMessages[2].content.includes('不应提供给基础档案用户'), '基础档案权限泄露了长期计划');
  assert(!capturedMessages[2].content.includes('不应提供的事件'), '基础档案权限泄露了长期事件');
  assert(capturedMessages[2].content.includes('不得声称已经读取、更新或执行长期方案'), '没有明确长期权限边界');

  const weeklyResult = await answerFollowUp({
    messages: [{ role: 'human', content: '好的' }],
    longTermContext: {
      ...makeContext(),
      timeline: { dueCheckIn: 'weekly_review', weightTrend: { status: 'insufficient_data' } },
    },
  }, { chatModel: fakeModel });
  assert(/同一台秤/.test(weeklyResult.messages[0].content), '第8天周复盘没有邀请标准化称重');
  assert(/不会只凭一次数字/.test(weeklyResult.messages[0].content), '周复盘没有说明按连续趋势判断');

  const dinnerAck = await answerFollowUp({
    messages: [{ role: 'human', content: 'ok' }],
    initialPlanDelivered: true,
    longTermContext: {
      ...makeContext(),
      temporalContext: {
        ...makeContext().temporalContext,
        mealTiming: { suggestedMeal: 'dinner', suggestedMealLabel: '晚餐' },
      },
      timeline: { dueCheckIn: null, weightTrend: { status: 'trend_available' } },
    },
  }, { chatModel: fakeModel });
  assert(/今晚这顿/.test(dinnerAck.messages[0].content), '晚上接受方案后没有承接今晚这一顿');
  assert(/老样子/.test(dinnerAck.messages[0].content), '长期用户收尾仍然使用生硬重复话术');
  assert(!/明天的餐/.test(dinnerAck.messages[0].content), '晚上接受方案后仍泛问明天的餐');

  const plateauContext = {
    ...makeContext(),
    timeline: { dueCheckIn: null, weightTrend: { status: 'possible_plateau' } },
  };
  const returningLongTermState = {
    messages: [{ role: 'human', content: '你好，我是女大学生，想减脂' }],
    // 模拟旧线程仍残留首次采集槽位；长期身份仍必须覆盖这些旧状态。
    slots: {
      scene: { value: 'cafeteria', confirmed: true },
    },
    longTermContext: plateauContext,
  };
  assert(
    shouldRouteReturningUserToFollowUp(returningLongTermState),
    '长期身份被旧线程槽位误判成首次建档用户'
  );
  assert(
    routeEntry(returningLongTermState) === 'answerFollowUp',
    '长期用户重复自我介绍后仍被送回首次信息采集'
  );

  const noModel = { async invoke() { throw new Error('确定性回复不应调用模型'); } };
  const repeatedGoal = await answerFollowUp(returningLongTermState, { chatModel: noModel });
  assert(/目标一直是减脂/.test(repeatedGoal.messages[0].content), '没有承认长期用户已有减脂目标');
  assert(/阶段复盘/.test(repeatedGoal.messages[0].content), '可能平台期用户没有承接当前进度');
  assert(!/食堂还是外卖|第一个小问题|简单了解/.test(repeatedGoal.messages[0].content), '长期用户又被拉回首次采集');

  const executionExplanation = await answerFollowUp({
    messages: [{ role: 'human', content: '什么是执行情况呢？' }],
    longTermContext: plateauContext,
  }, { chatModel: noModel });
  const executionText = executionExplanation.messages[0].content;
  assert(/哪些搭配容易做到/.test(executionText), '执行情况没有给出饮食可执行性示例');
  assert(/分量够不够/.test(executionText), '执行情况没有解释饱腹和分量反馈');
  assert(/不是检查你有没有严格照做/.test(executionText), '执行情况说明可能给用户造成考核感');

  console.log('✅ 仅长期服务用户会向answerFollowUp注入长期上下文');
  console.log('✅ 上下文只含最小必要摘要，不含用户ID、记录ID、来源或原始文本');
  console.log('✅ 当前计划、能量估算和近期事件有数量与长度上限');
  console.log('✅ 已有基础档案的新会话可识别老用户，但不会读取计划与事件');
  console.log('✅ 第8天周复盘会邀请同条件称重，并说明不凭单次数字下结论');
  console.log('✅ 晚上接受方案后承接今晚这顿，不再泛问明天的餐');
  console.log('✅ 长期身份优先于旧线程槽位，重复目标不会重新触发首次采集');
  console.log('✅ “执行情况”使用具体例子解释，并明确不是检查或考核');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

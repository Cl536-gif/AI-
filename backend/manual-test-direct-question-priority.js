const assert = require('assert');
const {
  isQuestionCandidate,
  detectDirectQuestion,
  answerDirectQuestion,
  detectDirectAnswerIssues,
  buildEmptyProfileDirectAnswer,
  shouldUseEmptyProfileMealAnswer,
  stripTrailingCollectionQuestion,
  stripRepeatedWelcome,
} = require('./src/langgraph/nodes/directQuestion');
const { routeEntry, routeAfterDirectQuestion } = require('./src/langgraph/graph');

function emptySlots() {
  return {
    scene: { value: null, confirmed: false },
    taste: { value: null, confirmed: false },
    budget: { value: null, confirmed: false },
    restrictions: { value: null, confirmed: false },
    goal: { value: null, confirmed: false },
    exercise: { value: null, confirmed: false },
    cafeteriaMode: { value: null, confirmed: false },
  };
}

async function main() {
  assert.equal(isQuestionCandidate('我今天中午该怎么吃？'), true);
  assert.equal(isQuestionCandidate('你能提醒我吗'), true);
  assert.equal(isQuestionCandidate('晚上跑步40分钟，今天怎么吃'), true);
  assert.equal(isQuestionCandidate('食堂自选'), false);
  assert.equal(isQuestionCandidate('好的'), false);

  const detected = await detectDirectQuestion(
    { messages: [{ role: 'human', content: '晚上跑步40分钟，我今天怎么吃？' }] },
    {
      detector: {
        invoke: async () => ({ hasDirectQuestion: true, questionText: '我今天怎么吃？' }),
      },
    }
  );
  assert.equal(detected.directQuestion, '晚上跑步40分钟，我今天怎么吃？');

  const deterministic = await detectDirectQuestion(
    { messages: [{ role: 'human', content: '今天中午只能点外卖，晚上跑步40分钟，我现在该怎么吃？' }] },
    { detector: { invoke: async () => { throw new Error('高置信问题不应依赖模型'); } } }
  );
  assert.match(deterministic.directQuestion, /只能点外卖/);

  const noQuestion = await detectDirectQuestion(
    { messages: [{ role: 'human', content: '晚上跑步40分钟' }] },
    { detector: { invoke: async () => { throw new Error('不应调用模型'); } } }
  );
  assert.equal(noQuestion.directQuestion, null);

  const calls = [];
  const answered = await answerDirectQuestion(
    {
      directQuestion: '我今天怎么吃？',
      longTermContext: {
        accessMode: 'long_term',
        serviceStatus: 'trial_active',
        profile: { profile: { body: { ageYears: 22 }, diet: { scene: '食堂' } } },
      },
    },
    {
      chatModel: {
        invoke: async (messages) => {
          calls.push(messages);
          return { content: '中午正常吃一份主食、蛋白质和蔬菜，晚上跑步后不用挨饿。' };
        },
      },
    }
  );
  assert.equal(answered.directQuestion, null);
  assert.match(answered.messages[0].content, /中午正常吃/);
  assert.ok(calls[0].some((message) => String(message.content).includes('22')));
  assert.deepEqual(
    detectDirectAnswerIssues(
      '中午点外卖，晚上跑步，手表显示300千卡，我怎么吃？',
      '中午点外卖正常搭配，晚上跑步后正常吃，手表消耗只作参考，不精确补偿。'
    ),
    []
  );
  assert.ok(detectDirectAnswerIssues('我怎么吃？', '豆腐吃一拳。那我接着问你预算？').length >= 2);
  assert.ok(
    detectDirectAnswerIssues(
      '今天午餐怎么吃？',
      '按你之前食堂自选的老底子来搭配。',
      { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] }
    ).includes('没有档案或历史时编造了用户习惯')
  );
  assert.ok(
    detectDirectAnswerIssues(
      '今天午餐怎么吃？',
      '今天午餐，咱们先按“食堂自己打饭”来搭配哈。',
      { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] }
    ).includes('没有档案或历史时编造了用户习惯')
  );
  assert.ok(
    detectDirectAnswerIssues(
      '今天午餐怎么吃？',
      '今天午餐，咱们先按最基础的食堂常见搭配来。',
      { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] }
    ).includes('没有档案或历史时编造了用户习惯')
  );
  assert.deepEqual(
    detectDirectAnswerIssues(
      '今天午餐怎么吃？',
      '如果你今天吃食堂，可以选一份主食、一份蛋白质和一份蔬菜。',
      { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] }
    ),
    []
  );

  let emptyContextAttempts = 0;
  const emptyContextAnswer = await answerDirectQuestion(
    {
      directQuestion: '如果我今天吃食堂，午餐怎么搭配？',
      longTermContext: { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] },
    },
    {
      chatModel: {
        async invoke() {
          emptyContextAttempts += 1;
          return emptyContextAttempts === 1
            ? { content: '按你之前食堂自选的老底子来搭配。' }
            : { content: '如果还没确定就餐场景，午餐先选一份主食、一份蛋白质和一份蔬菜。' };
        },
      },
    }
  );
  assert.equal(emptyContextAttempts, 2, '空档案伪记忆没有触发重试');
  assert.doesNotMatch(emptyContextAnswer.messages[0].content, /老底子|之前食堂/);

  let genericMealModelCalls = 0;
  const genericMealAnswer = await answerDirectQuestion(
    {
      directQuestion: '今天午餐怎么吃？',
      longTermContext: { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] },
    },
    {
      chatModel: {
        async invoke() {
          genericMealModelCalls += 1;
          return { content: '如果食堂没有西红柿炒蛋，可以换成蒸蛋。' };
        },
      },
    }
  );
  assert.equal(genericMealModelCalls, 0, '空档案通用餐食问题不应再调用模型猜测场景');
  assert.equal(genericMealAnswer.messages[0].content, buildEmptyProfileDirectAnswer('今天午餐怎么吃？'));
  assert.match(genericMealAnswer.messages[0].content, /不依赖个人档案的通用搭配/);
  assert.doesNotMatch(genericMealAnswer.messages[0].content, /如果食堂没有|西红柿炒蛋/);
  assert.equal(
    shouldUseEmptyProfileMealAnswer(
      '今天午餐怎么吃？',
      { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] }
    ),
    true
  );
  assert.equal(
    shouldUseEmptyProfileMealAnswer(
      '如果我今天吃食堂，午餐怎么搭配？',
      { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] }
    ),
    false
  );

  let persistentHallucinationAttempts = 0;
  const deterministicFallback = await answerDirectQuestion(
    {
      directQuestion: '如果我今天吃食堂，午餐怎么搭配？',
      longTermContext: { accessMode: 'basic_profile_only', profile: null, recentAdvice: [] },
    },
    {
      chatModel: {
        async invoke() {
          persistentHallucinationAttempts += 1;
          return { content: '按你一直重口味的老底子来搭配哈。' };
        },
      },
    }
  );
  assert.equal(persistentHallucinationAttempts, 3, '持续伪记忆时应耗尽三次模型重试');
  assert.equal(
    deterministicFallback.messages[0].content,
    buildEmptyProfileDirectAnswer('如果我今天吃食堂，午餐怎么搭配？')
  );
  assert.match(deterministicFallback.messages[0].content, /通用搭配/);
  assert.doesNotMatch(deterministicFallback.messages[0].content, /食堂自己打饭|老底子/);
  assert.equal(stripTrailingCollectionQuestion('先正常吃饭。那我接着问你预算？'), '先正常吃饭。');
  assert.equal(stripRepeatedWelcome('宝子回来啦～今天中午正常吃饭。', true), '今天中午正常吃饭。');

  const pendingBodyState = {
    directQuestion: '这是什么意思？',
    pendingBodyOnboarding: { askedCount: 1 },
    messages: [{ role: 'human', content: '22岁，这是什么意思？' }],
    slots: emptySlots(),
  };
  assert.equal(routeEntry(pendingBodyState), 'answerDirectQuestion');
  assert.equal(routeAfterDirectQuestion(pendingBodyState), 'resolveBodyOnboarding');

  const returningState = {
    directQuestion: null,
    messages: [{ role: 'human', content: '我今天怎么吃？' }],
    slots: emptySlots(),
    longTermContext: { profile: { profile: { body: { ageYears: 22 }, diet: {} } } },
  };
  assert.equal(routeAfterDirectQuestion(returningState), '__end__');

  const firstTurnState = {
    directQuestion: null,
    messages: [{ role: 'human', content: '你能提醒我吗？' }],
    slots: emptySlots(),
  };
  assert.equal(routeAfterDirectQuestion(firstTurnState), 'extractSlots');

  console.log('PASS: 明确问题优先回答，随后恢复待办流程且不会重复回答');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

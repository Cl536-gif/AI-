const assert = require('assert');
const { createInitialSlots } = require('./src/langgraph/state');
const {
  conflictRouter,
  hasExplicitFirstValueEvidence,
} = require('./src/langgraph/nodes/conflictRouter');
const { buildConfirmationText } = require('./src/langgraph/nodes/askConfirmation');
const { resolvePendingConfirmation } = require('./src/langgraph/nodes/resolvePendingConfirmation');
const { detectFormatViolations } = require('./src/services/formatGuard');
const { applyDeterministicExplicitCandidates } = require('./src/langgraph/nodes/extractSlots');
const { provideEmotionalSupport } = require('./src/langgraph/nodes/provideEmotionalSupport');
const { buildFallbackSlotQuestion } = require('./src/langgraph/nodes/askNextQuestion');

const BANNED = /(诶|哎|你刚说|你刚才|刚看到|刚听你说)/;

async function main() {
  const fullText =
    '我是女大学生，目标减脂，平时主要在食堂吃，食堂是自选，每顿预算20元，' +
    '喜欢酸甜和辣，没有忌口，每周跑步两次。';
  const candidates = {
    scene: '食堂',
    cafeteriaMode: '自己挑菜',
    budget: '每顿20元',
    taste: '喜欢酸甜和辣',
    restrictions: '没有忌口',
    goal: '减脂',
    exercise: '每周跑步两次',
  };
  Object.keys(candidates).forEach((field) => {
    assert.equal(hasExplicitFirstValueEvidence(field, fullText), true, `${field}缺少明确证据识别`);
  });

  const recovered = applyDeterministicExplicitCandidates(
    { scene: '食堂', cafeteriaMode: '自己挑菜', budget: '每顿20元', taste: '喜欢酸甜和辣', goal: '减脂' },
    fullText
  );
  assert.equal(recovered.restrictions, '没有忌口或已知过敏');
  assert.match(recovered.exercise, /每周跑步两次/);

  const received = await conflictRouter({
    messages: [{ role: 'human', content: fullText }],
    slots: createInitialSlots(),
    candidateSlots: candidates,
    candidateConfirmationReasons: {},
    lastAskedSlot: null,
    pendingConfirmation: null,
    pendingConfirmationQueue: [],
  });
  assert.equal(received.pendingConfirmation, undefined);
  assert.equal((received.pendingConfirmationQueue || []).length, 0);
  Object.keys(candidates).forEach((field) => {
    assert.deepEqual(received.slots[field], { value: candidates[field], confirmed: true });
  });

  const inferred = buildConfirmationText({
    field: 'scene', oldValue: null, newValue: '食堂',
  });
  const correction = buildConfirmationText({
    field: 'budget', oldValue: '每顿20元', newValue: '每顿30元',
  });
  assert.equal(inferred, '这里我理解成“食堂”，对吗？');
  assert.match(correction, /前面记录的是/);
  assert.doesNotMatch(`${inferred}${correction}`, BANNED);
  assert.doesNotMatch(`${inferred}${correction}`, /最近/);

  const resolved = await resolvePendingConfirmation(
    {
      messages: [{ role: 'human', content: '对' }],
      slots: createInitialSlots(),
      pendingConfirmation: { field: 'scene', oldValue: null, newValue: '食堂', askedCount: 1 },
      pendingConfirmationQueue: [
        { field: 'scene', oldValue: null, newValue: '食堂' },
        { field: 'budget', oldValue: null, newValue: '每顿20元' },
      ],
      lastAskedSlot: null,
    },
    { resolver: { invoke: async () => ({ resolution: 'confirmed' }) } }
  );
  assert.deepEqual(resolved.slots.scene, { value: '食堂', confirmed: true });
  assert.equal(resolved.pendingConfirmation.field, 'budget');
  assert.equal(resolved.pendingConfirmationQueue.length, 0);
  assert.deepEqual(resolved.skipCandidateFieldsOnce, ['scene']);

  const violations = detectFormatViolations('诶，你刚才是说在食堂吃饭吗？');
  assert.ok(violations.some((item) => item.type === 'mechanical_confirmation_opener'));

  const firstTurn = await provideEmotionalSupport({
    messages: [{ role: 'human', content: fullText }],
    longTermContext: null,
  });
  assert.match(firstTurn.messages[0].content, /我是你的私人健康饮食管理秘书/);
  const returningTurn = await provideEmotionalSupport({
    messages: [{ role: 'human', content: '今天吃什么？' }],
    longTermContext: { profile: { profile: { body: {}, diet: {} } } },
  });
  assert.deepEqual(returningTurn, {});

  const returningWithDistress = await provideEmotionalSupport({
    messages: [{ role: 'human', content: '我回来啦，偷吃薯片了，好焦虑' }],
    longTermContext: { profile: { profile: { body: {}, diet: {} } } },
  });
  assert.equal(returningWithDistress.messages[0].content, '宝子回来啦～');
  assert.match(returningWithDistress.messages[1].content, /这一顿不会把之前的努力全部推翻/);
  for (const field of ['scene', 'taste', 'budget', 'restrictions', 'goal', 'exercise']) {
    const question = buildFallbackSlotQuestion(field);
    assert.doesNotMatch(question, /(回到咱们刚才|确认清楚|你刚说|你刚才|诶|哎)/);
    assert.match(question, /[？?]/);
  }

  console.log('PASS: 清晰多字段整体接收，歧义确认使用自然模板，同字段不会重复排队');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

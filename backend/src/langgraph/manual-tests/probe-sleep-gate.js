const {
  applyDeterministicExplicitCandidates,
  gateSleepCandidates,
  isBareLabelEcho,
  sleepSemanticsIn,
} = require('../nodes/extractSlots');
const { hasExplicitFirstValueEvidence } = require('../nodes/conflictRouter');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const a = '我早上起不来，经常赖床到十点，晚上搞到两点才睡';
  const b = '中午就一个小时午休，下午还要上课';
  const c = '周末随便吃，平时凑合';
  const d = '今天睡到下午两点';

  const p1 = gateSleepCandidates(
    { wakeTime: '一般赖床到十点左右起床', stayUpLate: '晚上经常搞到两点才睡' },
    a
  );
  assert(p1.wakeTime === '一般赖床到十点左右起床', 'P1 wakeTime 未原样保留');
  assert(p1.stayUpLate === '晚上经常搞到两点才睡', 'P1 stayUpLate 未原样保留');
  assert(gateSleepCandidates({ wakeTime: '下午两点才起床' }, d).wakeTime === null, 'P2 单次起床未清空');
  assert(gateSleepCandidates({ stayUpLate: '中午午休一小时' }, b).stayUpLate === null, 'P3 午休误入熬夜');
  assert(gateSleepCandidates({ wakeTime: '平时凑合' }, c).wakeTime === null, 'P4 周末泛化误入起床');

  const p5 = applyDeterministicExplicitCandidates(
    { scene: null, taste: null, budget: null, restrictions: null, goal: null, exercise: null,
      wakeTime: null, stayUpLate: null },
    a
  );
  assert(p5.wakeTime?.includes('赖床'), `P5 wakeTime 未取习惯分句: ${p5.wakeTime}`);
  assert(p5.stayUpLate?.includes('两点才睡'), `P5 stayUpLate 未取原话: ${p5.stayUpLate}`);

  const p5b = applyDeterministicExplicitCandidates({ wakeTime: '上午10点', stayUpLate: null }, a);
  assert(p5b.wakeTime !== '上午10点' && p5b.wakeTime?.includes('赖床'), `P5b 残句未替换: ${p5b.wakeTime}`);

  const p6 = gateSleepCandidates(applyDeterministicExplicitCandidates({}, d), d);
  assert(!p6.wakeTime && !p6.stayUpLate, 'P6 单次事件产生作息候选');
  for (const text of [b, c]) {
    const p7 = gateSleepCandidates({ wakeTime: null, stayUpLate: null }, text);
    assert(!p7.wakeTime && !p7.stayUpLate, `P7 非作息文本产生候选: ${text}`);
  }
  assert(isBareLabelEcho('wakeTime', '起床时间'), 'P8 起床标签未拦截');
  assert(isBareLabelEcho('stayUpLate', '是否熬夜'), 'P8 熬夜标签未拦截');

  const expected = [
    [a, true, true],
    [b, false, false],
    [c, false, false],
    [d, false, false],
  ];
  for (const [text, wakeAllowed, stayUpAllowed] of expected) {
    const actual = sleepSemanticsIn(text);
    assert(actual.wakeAllowed === wakeAllowed && actual.stayUpAllowed === stayUpAllowed,
      `P9 语义矩阵不符: ${text} => ${JSON.stringify(actual)}`);
  }
  assert(hasExplicitFirstValueEvidence('wakeTime', a), 'P10 A wakeTime 应有证据');
  assert(!hasExplicitFirstValueEvidence('wakeTime', d), 'P10 D wakeTime 不应有证据');
  assert(!hasExplicitFirstValueEvidence('stayUpLate', b), 'P10 B stayUpLate 不应有证据');

  console.log('✅ P1-P10/P5b 作息采集端确定性探针全过');
  console.log(`P5 wakeTime=${p5.wakeTime}; stayUpLate=${p5.stayUpLate}`);
  console.log(`P5b wakeTime=${p5b.wakeTime}`);
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

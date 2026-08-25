const assert = require('assert');
const {
  normalizeTasteFromContext,
  normalizeExerciseFromContext,
} = require('../nodes/extractSlots');

function run() {
  assert.deepStrictEqual(
    normalizeTasteFromContext({ userText: '是的', lastAskedSlot: 'taste', extractedValue: null }),
    { value: null, reason: null },
    '通用确认词不能写成“喜欢是的”',
  );
  assert.deepStrictEqual(
    normalizeTasteFromContext({ userText: '🙂‍↕️', lastAskedSlot: 'taste', extractedValue: null }),
    { value: null, reason: null },
    'emoji 不能写进口味字段',
  );
  assert.strictEqual(
    normalizeExerciseFromContext({ userText: '没有', lastAskedSlot: 'exercise', extractedValue: null }),
    '目前没有运动',
    '运动问题后的“没有”必须绑定为不运动',
  );
  assert.strictEqual(
    normalizeExerciseFromContext({ userText: '没有', lastAskedSlot: 'restrictions', extractedValue: null }),
    null,
    '非运动问题后的“没有”不能误写运动字段',
  );
  console.log('scenario44 latest browser state regression: PASS');
}

run();

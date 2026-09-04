const {
  forceBothSceneIfEvidence,
  normalizeSceneFromContext,
} = require('../nodes/extractSlots');

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${expected}，实际 ${actual}`);
}

async function main() {
  const explicitBothCases = [
    '外卖食堂都会吃',
    '食堂外卖两个都吃',
    '平时外卖食堂都会吃',
    '我外卖食堂都会吃',
    '我食堂和外卖换着吃',
  ];
  for (const text of explicitBothCases) {
    const result = forceBothSceneIfEvidence({ scene: '食堂' }, text);
    assertEqual(result.scene, '食堂和外卖都会吃', text);
  }

  for (const text of ['两个都吃', '换着吃']) {
    const scene = normalizeSceneFromContext({
      userText: text,
      lastAskedSlot: 'scene',
      extractedValue: null,
    });
    assertEqual(scene, '食堂和外卖都会吃', text);
  }

  const questionScene = normalizeSceneFromContext({
    userText: '食堂外卖都吃吗？',
    lastAskedSlot: 'scene',
    extractedValue: null,
  });
  assertEqual(questionScene, null, '问句不应按上下文短答写入双场景');

  const negativeCases = [
    ['食堂和外卖哪个便宜？', null],
    ['食堂还是外卖怎么选', '食堂'],
    ['我不吃外卖，只去食堂吃', '食堂'],
  ];
  for (const [text, original] of negativeCases) {
    const result = forceBothSceneIfEvidence({ scene: original }, text);
    assertEqual(result.scene, original, `不应强制双场景：${text}`);
  }

  console.log('✅ 双场景支持前缀、换序和上下文短答');
  console.log('✅ 比较问句、选择问句和否定场景不会触发强制覆盖');
}

main().catch((err) => {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
});

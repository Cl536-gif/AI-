const { isUnsupportedSceneGuess, normalizeSceneFromContext } = require('../nodes/extractSlots');
const { askNextQuestion } = require('../nodes/askNextQuestion');

async function main() {
  const falseTriggers = [
    '我是校男大学生',
    '我是男大学生',
    '我是在校学生',
    '你好我要减脂，我是校男大学生可以吗',
  ];
  falseTriggers.forEach((text) => {
    if (!isUnsupportedSceneGuess('scene', '食堂', text, null)) {
      throw new Error(`把学生身份误当成食堂证据: ${text}`);
    }
  });

  const validEvidence = ['我平时吃食堂', '学校里吃饭', '一般去饭堂', '每天打饭'];
  validEvidence.forEach((text) => {
    if (isUnsupportedSceneGuess('scene', '食堂', text, null)) {
      throw new Error(`误删了真实食堂场景: ${text}`);
    }
  });

  if (isUnsupportedSceneGuess('scene', '外卖', '平时点外卖', null)) {
    throw new Error('误删了真实外卖场景');
  }

  ['都吃', '两个都吃', '都有', '换着吃', '混着吃', '食堂和外卖都吃'].forEach((text) => {
    const normalized = normalizeSceneFromContext({
      userText: text,
      lastAskedSlot: 'scene',
      extractedValue: null,
    });
    if (normalized !== '食堂和外卖都会吃') {
      throw new Error(`上一轮明确问场景时没有识别“两种都吃”: ${text}`);
    }
    if (isUnsupportedSceneGuess('scene', normalized, text, 'scene')) {
      throw new Error(`正确识别的混合就餐场景又被证据检查误删: ${text}`);
    }
  });

  if (normalizeSceneFromContext({ userText: '都吃', lastAskedSlot: 'restrictions', extractedValue: null })) {
    throw new Error('问忌口时把“都吃”误判成食堂和外卖都吃');
  }
  const mixedSceneReply = await askNextQuestion({
    nextSlotToAsk: 'cafeteriaMode',
    slots: { scene: { value: '食堂和外卖都会吃', confirmed: true } },
    messages: [{ role: 'human', content: '都吃' }],
  });
  const mixedSceneText = mixedSceneReply.messages.map((item) => item.content).join('\n');
  if (!mixedSceneText.includes('食堂和外卖会穿插着吃')) {
    throw new Error(`保存混合场景后没有向用户明确复述: ${mixedSceneText}`);
  }

  console.log('✅ 学生/学校身份不会再被推断成食堂');
  console.log('✅ 食堂、饭堂、打饭和外卖等明确原话仍能正常识别');
  console.log('✅ 问“食堂还是外卖”时，“都吃/换着吃/混着吃”会保存为两种穿插');
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

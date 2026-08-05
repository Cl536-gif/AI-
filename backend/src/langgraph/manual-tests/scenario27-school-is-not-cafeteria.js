const { isUnsupportedSceneGuess } = require('../nodes/extractSlots');

function main() {
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

  console.log('✅ 学生/学校身份不会再被推断成食堂');
  console.log('✅ 食堂、饭堂、打饭和外卖等明确原话仍能正常识别');
}

try {
  main();
} catch (err) {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
}

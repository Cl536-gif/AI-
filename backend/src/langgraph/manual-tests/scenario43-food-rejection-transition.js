const {
  normalizeFoodRejectionTransition,
  TASTE_PROFILE_SCENE_TRANSITION,
} = require('../nodes/askNextQuestion');

function main() {
  const original =
    '那咱们换一个！清炒时蔬换成水煮西兰花，蒸鸡腿换成卤豆腐块～\n' +
    '顺便再确认一下：平时吃饭主要是食堂还是外卖呀？';
  const normalized = normalizeFoodRejectionTransition(original, '不爱吃', 'scene');
  if (!normalized.includes('那咱们换一个')) throw new Error('替换过渡时误删了前面的回应');
  if (!normalized.endsWith(TASTE_PROFILE_SCENE_TRANSITION)) throw new Error(`没有使用新的饮食习惯过渡：${normalized}`);
  if (normalized.includes('顺便再确认')) throw new Error('仍残留核对表式措辞');

  const unaffected = normalizeFoodRejectionTransition('你平时预算多少呀？', '30', 'budget');
  if (unaffected !== '你平时预算多少呀？') throw new Error('误改了无关采集场景');

  console.log('✅ 用户拒绝临时菜品后，保留换菜回应并用饮食习惯价值自然接回场景问题');
  console.log('✅ 不再出现“顺便再确认一下”的核对表式措辞');
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

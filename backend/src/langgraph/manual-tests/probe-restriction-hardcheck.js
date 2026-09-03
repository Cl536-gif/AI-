const { detectRestrictionPlanViolations } = require('../nodes/generatePlan');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(label, restrictions, body, shouldViolate) {
  const violations = detectRestrictionPlanViolations(`档案复述\n\n${body}`, restrictions);
  if (shouldViolate) assert(violations.length > 0, `${label} 应拦截但返回 []`);
  else assert(violations.length === 0, `${label} 应放行但返回 ${JSON.stringify(violations)}`);
  console.log(`✅ ${label}: ${JSON.stringify(violations)}`);
}

function main() {
  check('⑤ 共现半程', '上次吃虾进急诊了', '主菜选白灼虾。', true);
  check('⑥ 段级原因链', '对虾过敏，还需避开蟹', '主菜选蟹粉豆腐。', true);
  check('⑥b 同句链+字面', '对虾过敏，还需避开蟹', '主菜选清蒸鲈鱼，主菜、配菜和替代均不含虾和蟹。', false);
  check('⑦ 泛词双闸', '吃那个不舒服', '主菜选任意家常菜。', false);
  check('⑧-1 海鲜扩虾', '对海鲜过敏', '主菜选白灼虾，另有菜品均不含海鲜。', true);
  check('⑧-1b 海鲜扩蟹贝', '对海鲜过敏', '主菜选清蒸蟹和辣炒花蛤，另有菜品均不含海鲜。', true);
  check('⑧-2 鱼族放行', '对海鲜过敏', '主菜选清蒸鲈鱼，主菜、配菜和替代均不含海鲜。', false);
  check('⑧-3 鱼香放行', '对海鲜过敏', '主菜选鱼香肉丝，主菜、配菜和替代均不含海鲜。', false);
  check('⑧-4 椰奶放行', '对奶制品过敏', '饮品选椰奶，主菜、配菜和替代均不含奶制品。', false);
  check('⑧-5 坚果扩花生', '对坚果过敏', '主菜选宫保鸡丁，另有菜品均不含坚果。', true);
  check('⑧-6 奶制品扩芝士', '对奶制品过敏', '主食选芝士焗饭，饮品选奶茶，另有菜品均不含奶制品。', true);
  check('⑧-7 芒果隐形', '对芒果过敏', '甜品选杨枝甘露，另有菜品均不含芒果。', true);
  check('⑨ 香菜 soft 守卫', '不吃香菜', '主菜选香菜拌牛肉。', false);
  check('⑨b 独立句连坐消除', '对虾过敏。不吃香菜', '主菜选香菜拌牛肉，主菜、配菜和替代均不含虾。', false);
  check('⑮ 否定守卫', '对花生不过敏', '加餐选花生米。', false);
  check('⑯ 3c anchor 声明', '对花生过敏', '主菜选清蒸鸡腿。', true);
  check('⑯b 3c 满足', '对花生过敏', '主菜选清蒸鸡腿，主菜、配菜和替代均不含花生。', false);
  check('⑰ 3a/3b 弱化', '对虾过敏', '主菜选白灼虾，虾少吃一点就行。', true);
  console.log('✅ 忌口硬校验探针矩阵全部通过');
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

async function runConversation(label, restrictionAnswer, runNumber) {
  const { graph } = require('../graph');
  const turns = [
    '食堂', '自选', '偏辣', '30块', restrictionAnswer,
    label === 'A8' ? '想拍照更上镜' : '想保持体重',
    '不运动', '先免费问问',
  ];
  let state = {};
  for (const userText of turns) {
    // eslint-disable-next-line no-await-in-loop
    state = await graph.invoke({
      ...state,
      messages: [...(state.messages || []), { role: 'human', content: userText }],
    });
  }
  const reply = [...(state.messages || [])].reverse().find((message) => message.role !== 'human')?.content || '';
  const storedRestriction = state.slots?.restrictions?.value || restrictionAnswer;
  console.log(`\n@@E2E ${label}-${runNumber}`);
  console.log(JSON.stringify({ restriction: storedRestriction, reply }, null, 2));
  assert(state.initialPlanDelivered === true, `${label}-${runNumber} 未正常交付方案`);
  assert(!reply.includes('没有通过忌口安全检查'), `${label}-${runNumber} 最终仍为拒发话术`);
  assert(detectRestrictionPlanViolations(reply, storedRestriction).length === 0,
    `${label}-${runNumber} 最终方案未通过硬校验`);

  if (label === '虾') {
    assert(/不含[^。！？\n]{0,4}虾|虾[^。！？\n]{0,4}(?:不含|不放|完全避开)/.test(reply), `${label}-${runNumber} 缺声明`);
  } else if (label === '奶制品') {
    assert(/不含[^。！？\n]{0,4}牛奶|牛奶[^。！？\n]{0,4}(?:不含|不放|完全避开)/.test(reply), `${label}-${runNumber} 缺声明`);
  } else if (label === '芒果') {
    assert(/不含[^。！？\n]{0,4}芒果|芒果[^。！？\n]{0,4}(?:不含|不放|完全避开)/.test(reply), `${label}-${runNumber} 缺声明`);
  } else if (label === '海鲜') {
    assert(/不含[^。！？\n]{0,4}海鲜|海鲜[^。！？\n]{0,4}(?:不含|不放|完全避开)/.test(reply), `${label}-${runNumber} 缺声明`);
  } else if (label === 'soft') {
    assert(/辣/.test(reply), `${label}-${runNumber} 软偏好方案没有保留辣味`);
  } else if (label === 'A8') {
    assert(!/宫保鸡丁/.test(reply), `A8-${runNumber} 出现宫保鸡丁`);
    assert(!/(?:少碰|挑出来不吃|避开里面的花生)/.test(reply), `A8-${runNumber} 出现弱化表述`);
  }
  assert(!reply.includes('按你的作息补充'), `${label}-${runNumber} 无作息事实却出现 A2 尾段`);
}

async function runE2E() {
  const allCases = [
    ['虾', '我对虾过敏'],
    ['奶制品', '牛奶不耐受，喝了拉肚子'],
    ['芒果', '吃芒果会起疹'],
    ['soft', '不吃辣，微辣可以'],
    ['海鲜', '对海鲜过敏'],
    ['A8', '不能吃花生'],
  ];
  const requestedCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length);
  const cases = requestedCase ? allCases.filter(([label]) => label === requestedCase) : allCases;
  assert(cases.length > 0, `未知 E2E case: ${requestedCase}`);
  for (const [label, restrictionAnswer] of cases) {
    for (let run = 1; run <= 3; run += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runConversation(label, restrictionAnswer, run);
    }
  }
  console.log('\n✅ 五组泛化 E2E 与 A8 各三遍全部通过');
}

if (process.argv.includes('--e2e')) {
  runE2E().catch((error) => {
    console.error(`❌ E2E ${error.message}`);
    process.exit(1);
  });
}

const {
  buildSleepSkeletonSection,
  normalizeMealTimingClosing,
  MEAL_TIMING_CLOSING,
} = require('../nodes/generatePlan');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const both = {
    wakeTime: { confirmed: true, value: '经常赖床到十点' },
    stayUpLate: { confirmed: true, value: '经常熬夜到凌晨两点' },
  };
  const s1 = buildSleepSkeletonSection(both);
  assert(s1.startsWith('\n\n（按你的作息补充一句：'), 'S1 前缀错误');
  assert(s1.endsWith('。）'), 'S1 后缀错误');
  assert(s1.includes('你经常赖床到十点，起床后的第一餐'), 'S1 缺 wake 句');
  assert(s1.includes('你经常熬夜到凌晨两点，深夜到凌晨'), 'S1 缺 stayUp 句');

  const s2 = buildSleepSkeletonSection({ wakeTime: both.wakeTime });
  assert(s2 && s2.includes('起床后的第一餐'), 'S2 缺 wake 句');
  assert(!s2.includes('深夜到凌晨') && !s2.includes('宵夜'), 'S2 错拼 stayUp 句');

  const s3 = buildSleepSkeletonSection({
    stayUpLate: { confirmed: true, value: '一般十一点前就睡了，不熬夜' },
  });
  assert(s3.includes('你一般十一点前就睡了，不熬夜，深夜到凌晨'), 'S3 原话直插不通顺或缺失');
  assert(!s3.includes('起床后的第一餐'), 'S3 错拼 wake 句');

  const emptyCases = [
    {},
    { wakeTime: { confirmed: false, value: '经常赖床到十点' } },
    { stayUpLate: { confirmed: true, value: '' } },
  ];
  for (const slots of emptyCases) assert(buildSleepSkeletonSection(slots) === '', 'S4 应返回空串');

  const source = '好，记下了：…\n\n正文…这份搭配适合午餐或晚餐；如果想安排早餐，告诉我，我会另外给你早餐方案～';
  const s5 = normalizeMealTimingClosing(source) + buildSleepSkeletonSection(both);
  const closingIndex = s5.indexOf(MEAL_TIMING_CLOSING);
  const skeletonIndex = s5.indexOf('（按你的作息补充一句：');
  assert(closingIndex >= 0 && skeletonIndex > closingIndex, 'S5 作息段没有位于固定收尾之后');
  assert(s5.endsWith('。）'), 'S5 作息段未保留在文本末尾');

  console.log('✅ S1-S5 作息骨架确定性探针全过');
  console.log(s1);
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

async function runConversation(label, opening, runNumber, options = {}) {
  const { graph } = require('../graph');
  const turns = options.peanut
    ? ['食堂', '自选', '偏辣', '30块', '不能吃花生', '想拍照更上镜', '不运动', '先免费问问']
    : [opening, '食堂', '自选', '偏辣', '20块', '没有忌口', '想保持体重', '不运动', '先免费问问'];
  let state = {};
  const replies = [];
  for (const userText of turns) {
    const beforeCount = state.messages?.length || 0;
    // eslint-disable-next-line no-await-in-loop
    state = await graph.invoke({
      ...state,
      messages: [...(state.messages || []), { role: 'human', content: userText }],
    });
    const newMessages = (state.messages || []).slice(beforeCount + 1);
    const aiTexts = newMessages
      .filter((message) => message.role !== 'human')
      .map((message) => String(message.content || ''));
    replies.push({ user: userText, ai: aiTexts });
  }
  const finalReply = [...replies].reverse().flatMap((turn) => turn.ai).find(Boolean) || '';
  const wake = state.slots?.wakeTime;
  const stayUp = state.slots?.stayUpLate;
  const skeletonIndex = finalReply.indexOf('（按你的作息补充一句：');
  const skeleton = skeletonIndex >= 0 ? finalReply.slice(skeletonIndex) : '';

  if (label === 'A') {
    assert(wake?.confirmed && wake.value, `A${runNumber} wakeTime 未确认`);
    assert(stayUp?.confirmed && stayUp.value, `A${runNumber} stayUpLate 未确认`);
    assert(skeleton.includes(wake.value) && skeleton.includes(stayUp.value), `A${runNumber} 尾段未包含终态值`);
    assert(finalReply.endsWith('。）'), `A${runNumber} 作息段不在末尾`);
    const body = finalReply.slice(0, skeletonIndex);
    assert(!/(?:明早|明早上)[^。！？\n]{0,12}(?:8|八)点前吃早餐|起床后[^。！？\n]{0,8}(?:7|七)点半吃早餐/.test(body),
      `A${runNumber} 正文锁死早餐时点`);
    assert(!/\*\*[^*]+\*\*/.test(finalReply), `A${runNumber} 出现粗体`);
    assert(!/^\s*(?:[-•]|\d+[.、)])\s+/m.test(finalReply), `A${runNumber} 出现列表`);
    assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(finalReply), `A${runNumber} 出现 emoji`);
  } else if (label === 'A8') {
    assert(!skeleton, `A8-${runNumber} 无作息却出现作息段`);
    assert(!/宫保鸡丁/.test(finalReply), `A8-${runNumber} 出现宫保鸡丁`);
    assert(!/(?:少碰|挑出来不吃|避开里面的花生)/.test(finalReply), `A8-${runNumber} 出现弱化花生话术`);
    assert(/(?:不含|排除|避开|不碰)[^。！？\n]{0,12}花生|花生[^。！？\n]{0,12}(?:不含|排除|避开|不碰)/.test(finalReply),
      `A8-${runNumber} 缺明确花生排除`);
  } else {
    assert(!wake?.value && !stayUp?.value, `${label}${runNumber} 误建档作息: ${JSON.stringify({ wake, stayUp })}`);
    assert(!skeleton, `${label}${runNumber} 误拼作息段`);
    const allAi = replies.flatMap((turn) => turn.ai).join('\n');
    assert(!/(?:作息|起床时间|几点起床|熬夜情况|是否熬夜)/.test(allAi), `${label}${runNumber} AI 主动确认/追问作息`);
    if (label === 'D') assert(!/下午两点[^。！？\n]{0,15}(?:习惯|平时|通常|经常)/.test(allAi), `D${runNumber} 把偶发当习惯`);
  }

  console.log(`\n@@RESULT ${label}-${runNumber}`);
  console.log(JSON.stringify({ slots: { wakeTime: wake, stayUpLate: stayUp }, replies }, null, 2));
}

async function runE2E() {
  const scenarios = [
    ['A', '我早上起不来，经常赖床到十点，晚上搞到两点才睡'],
    ['B', '中午就一个小时午休，下午还要上课'],
    ['C', '周末随便吃，平时凑合'],
    ['D', '今天睡到下午两点'],
  ];
  if (process.argv.includes('--e2e-core')) {
    for (const [label, opening] of scenarios) {
      for (let run = 1; run <= 3; run += 1) {
        // eslint-disable-next-line no-await-in-loop
        await runConversation(label, opening, run);
      }
    }
  }
  if (process.argv.includes('--a8')) {
    for (let run = 1; run <= 3; run += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runConversation('A8', '食堂', run, { peanut: true });
    }
  }

  if (process.argv.includes('--e1')) {
    const { graph } = require('../graph');
    const e1 = await graph.invoke({ messages: [{ role: 'human', content: '今晚想吃火锅' }] });
    const e1Reply = [...e1.messages].reverse().find((message) => message.role !== 'human')?.content || '';
    assert(/火锅/.test(e1Reply), 'E1 未接住火锅诉求');
    assert(/(?:肉|菜|主食|蘸料|汤底|吃完)/.test(e1Reply), 'E1 未给判断依据');
    console.log('\n@@RESULT E1-1');
    console.log(JSON.stringify({ reply: e1Reply }, null, 2));
  }
  console.log('\n✅ 所选 E2E 场景全部通过');
}

if (process.argv.some((arg) => ['--e2e-core', '--a8', '--e1'].includes(arg))) {
  runE2E().catch((error) => {
    console.error(`❌ E2E ${error.message}`);
    process.exit(1);
  });
}

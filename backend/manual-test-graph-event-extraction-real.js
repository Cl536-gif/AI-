require('dotenv').config();
const { extractGraphEvents } = require('./src/services/graphEventExtractionService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = {
    threadId: 'real-event-extraction-test',
    now: '2026-08-05T20:00:00+08:00',
    timezone: 'Asia/Shanghai',
  };

  const actual = await extractGraphEvents(
    '中午吃了一碗米饭和一个鸡腿，下午又吃了两片饼干，晚上跑了30分钟，手表显示消耗260千卡',
    options
  );
  const types = actual.map((event) => event.eventType);
  assert(types.includes('meal'), `没有识别已发生的正餐: ${JSON.stringify(actual)}`);
  assert(types.includes('snack'), `没有识别已发生的零食: ${JSON.stringify(actual)}`);
  assert(types.includes('exercise'), `没有识别已完成的运动: ${JSON.stringify(actual)}`);

  const question = await extractGraphEvents('明天早餐可以吃两个鸡蛋吗？', options);
  assert(question.length === 0, `饮食问题被误记为事件: ${JSON.stringify(question)}`);

  const onboarding = await extractGraphEvents('22岁，165厘米，现在60公斤，目标55公斤', options);
  assert(onboarding.length === 0, `建档信息被误记为测量事件: ${JSON.stringify(onboarding)}`);

  const futureExercise = await extractGraphEvents('我打算明天去跑步，如果不下雨的话', options);
  assert(futureExercise.length === 0, `尚未完成的运动被误记为事件: ${JSON.stringify(futureExercise)}`);

  const interruption = await extractGraphEvents('已经确定明天开始出差三天，这几天饮食计划可能会被打乱', options);
  assert(
    interruption.length === 1 && interruption[0].eventType === 'plan_interruption',
    `明确计划中断没有正确识别: ${JSON.stringify(interruption)}`
  );

  console.log(`✅ 真实模型识别已发生事件: ${types.join('、')}`);
  console.log('✅ 真实模型没有把饮食问题记成正餐');
  console.log('✅ 真实模型没有把建档身体数据记成测量事件');
  console.log('✅ 真实模型没有把未来运动打算记成已完成运动');
  console.log('✅ 真实模型识别明确计划中断');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

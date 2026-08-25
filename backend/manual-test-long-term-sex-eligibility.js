const { createInitialSlots } = require('./src/langgraph/state');
const { askServiceChoice, EQUATION_SEX_QUESTION_MESSAGE } = require('./src/langgraph/nodes/askServiceChoice');
const {
  parseEquationSex,
  resolveEquationSexStage,
  MALE_LONG_TERM_UNAVAILABLE_MESSAGE,
} = require('./src/langgraph/nodes/resolveServiceChoice');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  assert(parseEquationSex('我是生理女性') === 'female', '没有识别生理女性');
  assert(parseEquationSex('女') === 'female', '没有识别简短女性回答');
  assert(parseEquationSex('我是男生') === 'male', '没有识别男性');
  assert(parseEquationSex('男') === 'male', '没有识别简短男性回答');
  assert(parseEquationSex('都可以') === null, '含糊回答被猜测成性别');

  const result = await askServiceChoice({
    slots: createInitialSlots(),
    pendingServiceChoice: { stage: 'equation_sex', askedCount: 0 },
    messages: [{ role: 'human', content: '我想用长期规划' }],
  });
  assert(result.messages[0].content === EQUATION_SEX_QUESTION_MESSAGE, '选择长期后没有先询问生理性别');
  assert(result.pendingServiceChoice.stage === 'equation_sex', '询问性别后错误进入提醒阶段');

  const maleResult = await resolveEquationSexStage({
    messages: [{ role: 'human', content: '我是男生' }],
  }, { stage: 'equation_sex', askedCount: 1 });
  assert(maleResult.serviceTier === 'free', '男性没有确定性回退免费问答');
  assert(maleResult.pendingServiceChoice === null, '男性仍进入了长期提醒流程');
  assert(maleResult.equationSex === 'male', '男性计算参数没有记录');
  assert(maleResult.messages[0].content === MALE_LONG_TERM_UNAVAILABLE_MESSAGE, '男性服务边界话术不稳定');

  const femaleResult = await resolveEquationSexStage({
    messages: [{ role: 'human', content: '生理女性' }],
  }, { stage: 'equation_sex', askedCount: 1 });
  assert(femaleResult.pendingServiceChoice.stage === 'schedule', '女性没有继续进入提醒设置');
  assert(femaleResult.serviceTier === undefined, '女性在提醒时间确认前被提前标记长期服务');

  console.log('✅ 长期选择后第一步先询问生理性别');
  console.log('✅ 女性和男性表达确定性识别，含糊回答不会被猜测');
  console.log('✅ 男性回退免费且不进入提醒，女性继续长期建档');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

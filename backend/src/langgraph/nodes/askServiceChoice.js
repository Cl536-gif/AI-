// 服务边界问询节点：checkCompleteness 判定六项信息全部确认、且
// state.serviceTier 还是 null 时，走到这里。问的是"免费临时问答 还是
// 开通付费定期推送服务"这个分岔，出方案前必须先问清楚这个，不能默认
// 开通、也不能默认免费就直接跳过不问。
//
// 这段话涉及试用期天数、付费周期这类事实性条款，走确定性模板，不经过
// LLM重新组织语言——防止条款被复述错、被简化掉关键信息，跟
// askNextQuestion/generatePlan那种需要结合上下文自然应变的场景不同，
// 这里内容固定、跟对话上下文无关，适合模板化。
//
// 这个节点同时负责"第一次问"和"含糊后重问"两种情况（用法上对应
// askConfirmation.js 的 askedCount 计数惯例）：
// - pendingServiceChoice 为 null：第一次问，完整的服务边界+分岔话术。
// - stage 'choice'：用户上次回答没讲清楚，简短重问一次选哪个。
// - stage 'schedule'：第一次问推送时间，或者用户上次没讲清楚具体时间、
//   简短重问一次。
const { buildPushServiceClause } = require('../../pricingConfig');

const SERVICE_BOUNDARY_MESSAGE =
  '在给你出方案之前，先跟你说清楚我们能做什么——如果是饮食建议的话可以随时来问我，这个功能是免费的哈，' +
  '我不会自动推送信息给你，你想到了就来找我聊；如果是想针对身材目标做定期、结构化的饮食调整，你可以开启' +
  '信息推送服务，我会按你设定的时间提醒你当天的饮食安排。' +
  buildPushServiceClause() +
  '你可以先随便问问看，如果想开通推送随时告诉我就行～';

const SERVICE_CHOICE_RETRY_MESSAGE =
  '不好意思，刚才没太听明白～你想先用免费的饮食问答就好，还是要开通那个定期推送服务，告诉我一声就行～';

const SCHEDULE_QUESTION_MESSAGE =
  '好嘞，那你想设定什么时候提醒你呢，跟我说个大概时间就行～';

const SCHEDULE_RETRY_MESSAGE =
  '不好意思，没太听清楚具体时间，你希望我大概几点提醒你呀，说个大概时间就行～';

async function askServiceChoice(state) {
  const pending = state.pendingServiceChoice;

  if (!pending) {
    return {
      messages: [{ role: 'ai', content: SERVICE_BOUNDARY_MESSAGE }],
      pendingServiceChoice: { stage: 'choice', askedCount: 1 },
    };
  }

  if (pending.stage === 'choice') {
    return {
      messages: [{ role: 'ai', content: SERVICE_CHOICE_RETRY_MESSAGE }],
      pendingServiceChoice: { ...pending, askedCount: (pending.askedCount || 0) + 1 },
    };
  }

  const isFirstScheduleAsk = (pending.askedCount || 0) === 0;
  return {
    messages: [{ role: 'ai', content: isFirstScheduleAsk ? SCHEDULE_QUESTION_MESSAGE : SCHEDULE_RETRY_MESSAGE }],
    pendingServiceChoice: { ...pending, askedCount: (pending.askedCount || 0) + 1 },
  };
}

module.exports = {
  askServiceChoice,
  SERVICE_BOUNDARY_MESSAGE,
  SERVICE_CHOICE_RETRY_MESSAGE,
  SCHEDULE_QUESTION_MESSAGE,
  SCHEDULE_RETRY_MESSAGE,
};

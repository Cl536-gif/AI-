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
const { getMessageRole, getMessageText } = require('../utils/messages');
const { getUndeliveredMuscleGoalGuidance } = require('../goalGuidance');

const MALE_SELF_DISCLOSURE_REGEX = /(?:(?:我是|本人是|我算是|性别(?:是|为)?)[^。！？]{0,8}(?:男大学生|男学生|男生|男性|男的)|(?:^|[，,。！？!?；;：:\s])(?:在校)?男大学生(?:[，,。！？!?；;：:\s]|$))/;
const MALE_FREE_ONLY_MESSAGE =
  '目前长期饮食定制和阶段调整主要面向想减脂、塑形的在校女生。你仍然可以使用免费的科学饮食问答，' +
  '我也会根据刚才收集的信息先给你第一版基础方案，但暂时不会进入长期跟踪调整。';

function isMaleUser(messages) {
  return messages
    .filter((message) => getMessageRole(message) === 'human')
    .some((message) => MALE_SELF_DISCLOSURE_REGEX.test(getMessageText(message)));
}

const SERVICE_BOUNDARY_MESSAGE =
  '在给你第一版方案之前，先跟你说清楚两种使用方式，不管选哪一种，我都会先根据刚才的信息给你今天的第一版方案。' +
  '你可以选择免费的科学饮食问答：我会保留你的基础档案，你有问题时随时来问，但不会根据时间持续跟进或主动调整方案；' +
  '也可以选择长期规划服务：我会建立持续更新的长期档案，按你设定的时间跟进，并结合每个阶段的记录逐步调整饮食方案。' +
  buildPushServiceClause() +
  '你更想先用哪一种呢？';

const SERVICE_CHOICE_RETRY_MESSAGE =
  '不好意思，刚才没太听明白～告诉我你想选免费的科学饮食问答，或者长期规划服务就好。';

const SCHEDULE_QUESTION_MESSAGE =
  '饮食提醒就是我按你选的时间来问问“今天吃得怎么样”或者“下一餐想吃什么”，' +
  '你需要时我再结合当天情况帮你调整，不会一直打扰你～你希望每天、隔天、只在工作日、周末，' +
  '还是每周一次？再告诉我大概几点就行。';

const EQUATION_SEX_QUESTION_MESSAGE =
  '在继续长期规划前，还需要确认一项用于后台计算的基础信息：你的生理性别是女性还是男性？';

const EQUATION_SEX_RETRY_MESSAGE =
  '这项会决定能量计算公式和长期服务资格，请直接告诉我是生理女性还是生理男性。';

const SUBSCRIPTION_ONBOARDING_OVERVIEW =
  '好～接下来还有三小项，大概两三分钟就能说完：\n\n' +
  '1. 饮食提醒的频率和时间\n' +
  '2. 年龄、身高、体重等基础信息\n' +
  '3. 经期和近期身体状态\n\n' +
  '我们一项一项来，不用一次全填完。现在没时间也没关系，今天有空时跟我说“继续建档”，我会从停下的位置接着来哈。';

const SCHEDULE_RETRY_MESSAGE =
  '不好意思，刚才的提醒安排还没听清楚～你可以告诉我多久提醒一次，再补充一个大概时间，比如工作日晚上或者每周日上午。';

async function askServiceChoice(state) {
  const pending = state.pendingServiceChoice;

  if (!pending) {
    const muscleGoalGuidance = getUndeliveredMuscleGoalGuidance(state);
    if (isMaleUser(state.messages)) {
      return {
        messages: [muscleGoalGuidance, MALE_FREE_ONLY_MESSAGE]
          .filter(Boolean)
          .map((content) => ({ role: 'ai', content })),
        serviceTier: 'free',
        pendingServiceChoice: null,
        ...(muscleGoalGuidance ? { muscleGoalGuidanceDelivered: true } : {}),
      };
    }
    return {
      messages: [muscleGoalGuidance, SERVICE_BOUNDARY_MESSAGE]
        .filter(Boolean)
        .map((content) => ({ role: 'ai', content })),
      pendingServiceChoice: { stage: 'choice', askedCount: 1 },
      ...(muscleGoalGuidance ? { muscleGoalGuidanceDelivered: true } : {}),
    };
  }

  if (pending.stage === 'choice') {
    return {
      messages: [{ role: 'ai', content: SERVICE_CHOICE_RETRY_MESSAGE }],
      pendingServiceChoice: { ...pending, askedCount: (pending.askedCount || 0) + 1 },
    };
  }

  if (pending.stage === 'equation_sex') {
    return {
      messages: [{
        role: 'ai',
        content: (pending.askedCount || 0) === 0
          ? EQUATION_SEX_QUESTION_MESSAGE
          : EQUATION_SEX_RETRY_MESSAGE,
      }],
      pendingServiceChoice: { ...pending, askedCount: (pending.askedCount || 0) + 1 },
    };
  }

  const isFirstScheduleAsk = (pending.askedCount || 0) === 0;
  return {
    messages: (isFirstScheduleAsk
      ? [SUBSCRIPTION_ONBOARDING_OVERVIEW, SCHEDULE_QUESTION_MESSAGE]
      : [SCHEDULE_RETRY_MESSAGE]
    ).map((content) => ({ role: 'ai', content })),
    pendingServiceChoice: { ...pending, askedCount: (pending.askedCount || 0) + 1 },
  };
}

module.exports = {
  askServiceChoice,
  SERVICE_BOUNDARY_MESSAGE,
  SERVICE_CHOICE_RETRY_MESSAGE,
  SCHEDULE_QUESTION_MESSAGE,
  SCHEDULE_RETRY_MESSAGE,
  SUBSCRIPTION_ONBOARDING_OVERVIEW,
  EQUATION_SEX_QUESTION_MESSAGE,
  EQUATION_SEX_RETRY_MESSAGE,
  MALE_FREE_ONLY_MESSAGE,
  isMaleUser,
};

const { z } = require('zod');
const { classifierModel, model } = require('../model');
const { SYSTEM_PROMPT } = require('../../services/systemPrompt');
const { findLastUserMessage, getMessageText } = require('../utils/messages');
const { buildFollowUpContextMessage } = require('./answerFollowUp');
const { getFixedProductAnswer } = require('./askNextQuestion');

const DirectQuestionSchema = z.object({
  hasDirectQuestion: z.boolean().describe('用户本轮是否明确向秘书提出了需要回答的问题'),
  questionText: z.string().nullable().describe('需要优先回答的问题原意；没有问题时填null'),
});

const structuredDetector = classifierModel.withStructuredOutput(DirectQuestionSchema, {
  name: 'detect_direct_user_question',
});

// 只把明显具有询问形式的消息交给模型，减少把普通回答误判为问题的概率。
// “我该怎么吃”这类没有问号的自然询问也必须覆盖。
const QUESTION_CANDIDATE_REGEX = /[?？]|(?:怎么|如何|为什么|什么(?:意思|原因|时候|食物|方案)?|能不能|可不可以|要不要|是不是|有没有|多少|哪里|哪种|哪一个|该不该|我该|怎么办)|(?:吗|嘛|么|呢)[。！!～~]*$/;
const HIGH_CONFIDENCE_QUESTION_REGEX = /(?:我(?:现在|今天|中午|晚上)?该怎么|我该|怎么吃|怎么办|如何吃|为什么|什么意思|你能不能|你能否|能不能帮|可不可以帮|需要付费吗|要收费吗)/;

function isQuestionCandidate(userText) {
  const text = String(userText || '').trim();
  if (!text) return false;
  return QUESTION_CANDIDATE_REGEX.test(text);
}

async function detectDirectQuestion(state, { detector = structuredDetector } = {}) {
  const userText = getMessageText(findLastUserMessage(state.messages)).trim();
  if (!isQuestionCandidate(userText)) {
    return { directQuestion: null, directQuestionAnsweredThisTurn: false };
  }

  // 这类明确求助句不应再由模型拥有否决权。真实复杂句中模型曾把
  // “我现在该怎么吃？”漏判为普通资料陈述，因此高置信表达直接进入
  // 回答分支；整句保留，让回答节点同时看到外卖、运动等必要条件。
  if (HIGH_CONFIDENCE_QUESTION_REGEX.test(userText)) {
    return { directQuestion: userText };
  }

  const result = await detector.invoke([
    {
      role: 'system',
      content:
        '判断用户本轮是否明确向健康饮食秘书提出了需要先回答的问题。' +
        '只是在回答秘书上一问、陈述资料、表达同意或拒绝，不算问题；' +
        '即使一句话同时回答了资料并提出问题，也要识别其中的问题。' +
        '不要把反问式的资料回答擅自扩写成新问题。questionText保留用户问题原意，简洁摘出即可。',
    },
    { role: 'human', content: userText },
  ]);

  return {
    directQuestion:
      result?.hasDirectQuestion && String(result.questionText || '').trim()
        ? userText
        : null,
  };
}

async function answerDirectQuestion(state, { chatModel = model } = {}) {
  const questionText = String(state.directQuestion || '').trim();
  if (!questionText) return { directQuestion: null };

  const contextMessage = buildFollowUpContextMessage(state.longTermContext);
  const fixedProductAnswer = getFixedProductAnswer(questionText);
  if (fixedProductAnswer) {
    return {
      messages: [{ role: 'ai', content: fixedProductAnswer }],
      directQuestion: null,
      directQuestionAnsweredThisTurn: true,
    };
  }
  const baseMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content:
          '现在只回答用户本轮提出的明确问题。先给直接、完整、可执行的答案；' +
          '逐项回应用户消息中会影响答案的条件，例如就餐方式、零食、当天运动和手表消耗。' +
          '不要在这条回复中继续资料收集，不要在结尾追加任何问题，不要重复自我介绍，' +
          '不要复述整份档案，也不要用问题代替答案。资料收集会由下一节点另发一条消息继续。' +
          '长期用户询问本周或当前规划时，如果上下文中activePlan存在，直接概括当前阶段目标和可执行安排，' +
          '不得说“这周没有规划”“尚未建立计划”；如果不是逐日菜单，可以说本周按阶段方向执行，不用每天卡死菜单。' +
          '不要重复说明这份搭配结合了用户的预算、食堂模式、口味、目标或档案，长期用户已经知道秘书会记住这些。' +
          '餐食建议可用“老样子，不爱吃或食堂没有就告诉我哈。我们一步一步来”自然收尾。' +
          '禁止用“吃完有感觉了告诉我”这种含糊表达；应明确说可以反馈分量够不够、多久又饿、是否不舒服或菜品是否买得到。' +
          '夜间承接下一餐时不得笼统说“明天的餐”；如确有必要，只能明确说“明天早餐”。' +
          '如果涉及卡路里或运动手表数据，说明它们只能作为估算参考，不做精确补偿。' +
          '长期方案的饮食结构与分量会结合后台能量需求估算来安排，不能笼统说“不会跟踪卡路里”。' +
          '如果用户在方案之外吃了零食、加餐、饮料或增加分量，秘书只有在用户主动告诉后才知道并记入当天记录；' +
          '必须区分“方案按估算热量规划”和“秘书无法自动看见未上报的实际摄入”。' +
          '如果用户询问秘书是否会要求、安排或催促运动，要说明运动由用户自行决定；同时自然告诉用户：' +
          '“如果当天安排了运动，可以提前或当天告诉我运动类型和大概时长，我会帮你适当调整当天的饮食结构和分量哈。”' +
          '不要说“方案默认按暂不安排固定运动来设计”，也不要让用户误以为秘书会制定训练计划。' +
          '食物单位必须匹配：蛋、鸡腿等按个/只，豆腐按块或克；不能把蛋、鸡腿、豆腐写成一拳或半拳。' +
          (state.emotionalSupportDeliveredThisTurn
            ? '前面的独立消息已经完成欢迎、共情和安慰，这里不要再说“回来啦”、不要重复安慰，只给具体解决办法。'
            : '') +
          '语言自然简洁，避免“诶、哎、你刚说、刚看到”和破折号。',
      },
      ...(contextMessage ? [contextMessage] : []),
      { role: 'human', content: questionText },
  ];

  let response;
  let issues = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    response = await chatModel.invoke([
      ...baseMessages,
      ...(issues.length
        ? [{
            role: 'system',
            content: `上一版未通过输出质检：${issues.join('；')}。请重新完整回答，且不要解释质检过程。`,
          }]
        : []),
    ]);
    issues = detectDirectAnswerIssues(questionText, response.content, state.longTermContext);
    if (issues.length === 0) break;
  }

  // 空档案时，模型即使收到明确约束也可能连续把食堂、口味等写成既定事实。
  // 这种错误不能在重试耗尽后原样放行；改用不依赖个人档案的确定性答案。
  if (issues.includes('没有档案或历史时编造了用户习惯')) {
    response = { content: buildEmptyProfileDirectAnswer(questionText) };
  }

  const safeContent = stripRepeatedWelcome(
    stripTrailingCollectionQuestion(response.content),
    state.emotionalSupportDeliveredThisTurn
  );

  return {
    messages: [{ role: 'ai', content: safeContent }],
    directQuestion: null,
    directQuestionAnsweredThisTurn: true,
  };
}

function stripRepeatedWelcome(value, shouldStrip) {
  const text = String(value || '').trim();
  if (!shouldStrip) return text;
  return text
    .replace(/^(?:宝子|宝宝|姐妹|闺蜜)?[，,\s]*(?:欢迎)?回来(?:啦|了|咯)?[～~！!，,\s]*/u, '')
    .trim();
}

function detectDirectAnswerIssues(questionText, answerText, longTermContext = null) {
  const question = String(questionText || '');
  const answer = String(answerText || '');
  const issues = [];
  if (/[?？]/.test(answer) || /(那我接着问|接下来想问|顺便问|再问你)/.test(answer)) {
    issues.push('回答中夹带了新的资料收集问题');
  }
  if (/外卖/.test(question) && !/外卖/.test(answer)) issues.push('没有回应外卖场景');
  if (/(跑步|运动|健身|打球|攀岩)/.test(question) && !/(跑步|运动|健身|打球|攀岩)/.test(answer)) {
    issues.push('没有回应当天运动安排');
  }
  if (/(手表|千卡|卡路里|消耗)/.test(question) && !/(手表|千卡|卡路里|消耗|参考|补偿)/.test(answer)) {
    issues.push('没有说明运动消耗数字的使用边界');
  }
  if (/(记录|跟踪|计算).{0,8}(?:热量|卡路里)|(?:热量|卡路里).{0,8}(?:记录|跟踪|计算)/.test(question) &&
      !/(方案|规划|估算).*(?:主动告诉|告诉我|额外|实际摄入)/s.test(answer)) {
    issues.push('没有区分方案热量规划与未上报的实际摄入');
  }
  if (/(鸡蛋|水煮蛋|蒸蛋|鸡腿|豆腐)[^。！？\n]{0,12}(?:半?拳|一拳)|(?:半?拳|一拳)[^。！？\n]{0,12}(鸡蛋|水煮蛋|蒸蛋|鸡腿|豆腐)/.test(answer)) {
    issues.push('蛋、鸡腿或豆腐使用了错误的拳头单位');
  }
  const hasKnownProfile = Boolean(longTermContext?.profile?.profile);
  const hasKnownHistory = Boolean(
    (longTermContext?.recentAdvice || []).length ||
    longTermContext?.activePlan ||
    longTermContext?.pausedPlan
  );
  const mealSceneTerms = ['食堂', '外卖', '固定套餐', '自己打饭'];
  const assertsUnknownMealScene = answer
    .split(/[。！？\n]+/u)
    .some((sentence) =>
      mealSceneTerms.some((term) => sentence.includes(term) && !question.includes(term)) &&
      !/(?:如果|假如|若是|若你|要是|倘若|不预设|没有确认|尚未确认|还没确定|并不知道)/.test(sentence)
    );
  const assertsUnknownProfile =
    /(?:老底子|按你(?:之前|原来|平时|一直)[^。！？\n]{0,16}(?:口味|预算|习惯|档案|记录)|之前的档案|你平时(?:主要)?(?:吃|点|不吃|喜欢))/.test(answer) ||
    /(?:咱们|今天|这顿)?[^。！？\n]{0,10}(?:先)?按[“"'‘’]?(?:食堂|外卖|自己打饭|固定套餐|重口味|清淡|酸甜|不吃|能吃)[^。！？\n]{0,24}(?:来|搭配|安排)/.test(answer) ||
    /(?:食堂自己打饭|固定套餐|经常点外卖|一贯重口味|一直吃得清淡)/.test(answer) ||
    assertsUnknownMealScene;
  if (!hasKnownProfile && !hasKnownHistory &&
      assertsUnknownProfile) {
    issues.push('没有档案或历史时编造了用户习惯');
  }
  return issues;
}

function buildEmptyProfileDirectAnswer(questionText) {
  const question = String(questionText || '');
  if (/(?:吃|餐|食物|外卖|食堂|早餐|午餐|晚餐|加餐)/.test(question)) {
    return (
      '我目前还没有你已确认的就餐方式和口味资料，所以先给你一个不依赖个人档案的通用搭配：' +
      '主食约一拳、蛋白质约一掌、蔬菜一到两拳，按你实际买得到的食物选择。' +
      '这里不预设你吃食堂、点外卖或偏好哪种口味，等你明确告诉我后再为你调整。'
    );
  }
  return (
    '我目前还没有你已确认的个人档案，所以不会假设你的口味、预算或生活习惯。' +
    '这条先按不依赖个人资料的通用原则处理；需要个性化的部分，等你明确提供后再调整。'
  );
}

function stripTrailingCollectionQuestion(value) {
  const text = String(value || '').trim();
  const marker = text.search(/(?:那我接着问|接下来想问|顺便问|再问你)/);
  const withoutCollection = marker >= 0 ? text.slice(0, marker).trim() : text;
  return withoutCollection.replace(/[^。！？\n]*[?？]\s*$/u, '').trim();
}

module.exports = {
  DirectQuestionSchema,
  QUESTION_CANDIDATE_REGEX,
  HIGH_CONFIDENCE_QUESTION_REGEX,
  isQuestionCandidate,
  detectDirectQuestion,
  answerDirectQuestion,
  detectDirectAnswerIssues,
  buildEmptyProfileDirectAnswer,
  stripTrailingCollectionQuestion,
  stripRepeatedWelcome,
};

const { z } = require('zod');
const { classifierModel } = require('../model');
const { findLastUserMessage, getMessageText } = require('../utils/messages');

const CONFIRM_REGEX = /^(?:对|是|是的|确认|没错|可以|好的?|就这些|按这个来)[。！!～~]?$/;
const REJECT_REGEX = /^(?:不对|不是|有遗漏|还要补充|需要修改|改一下|等等)[。！!～~]?$/;

const RevisionChangesSchema = z.object({
  changes: z.array(z.object({
    field: z.enum([
      'weight', 'height', 'age', 'activity_level', 'equation_sex',
      'goal', 'schedule', 'meal_environment', 'food_preference', 'health_status', 'other',
    ]),
    summary: z.string().trim().min(1).max(300),
  }).strict()).max(12),
  needsMoreDetail: z.boolean(),
  followUpQuestion: z.string().trim().max(300).nullable(),
}).strict();

function createRevisionChangeExtractor(model = classifierModel) {
  return model.withStructuredOutput(RevisionChangesSchema, { name: 'extract_plan_revision_changes' });
}

function mergeChanges(existing = [], incoming = []) {
  const merged = new Map(existing.map((change) => [change.field, change]));
  incoming.forEach((change) => merged.set(change.field, change));
  return [...merged.values()];
}

const FIELD_LABELS = {
  weight: '体重', height: '身高', age: '年龄', activity_level: '日常活动量',
  equation_sex: '能量方程参数', goal: '目标', schedule: '作息或上课时间',
  meal_environment: '就餐环境', food_preference: '口味或食物偏好',
  health_status: '健康状态', other: '其他持续变化',
};

function buildChangesConfirmation(changes) {
  const lines = changes.map((change, index) =>
    `${index + 1}. ${FIELD_LABELS[change.field]}：${change.summary}`);
  return `我先把需要调整的变化整理一下：\n\n${lines.join('\n')}\n\n这些信息都对吗？有遗漏也可以直接补充。`;
}

function startPlanRevision(state) {
  const pausedPlan = state.longTermContext?.pausedPlan;
  if (!pausedPlan) return {};
  return {
    messages: [{
      role: 'ai',
      content:
        '可以，我们按你现在的情况重新调整。先告诉我这段时间有哪些持续变化，比如：\n\n' +
        '1. 上课、作息或吃饭时间\n' +
        '2. 主要吃饭地点或食堂条件\n' +
        '3. 体重、活动量或目标\n' +
        '4. 口味、忌口或身体状况\n\n' +
        '可以一次把想到的都告诉我，我会逐项整理。',
    }],
    pendingPlanRevision: {
      stage: 'collect_changes',
      parentPlanId: pausedPlan.planId,
      parentPlanVersion: pausedPlan.planVersion,
      changes: [],
      askedCount: 1,
    },
    confirmedPlanRevisionRequest: null,
  };
}

function createResolvePlanRevision({ extractor = createRevisionChangeExtractor() } = {}) {
  return async function resolvePlanRevision(state) {
    const pending = state.pendingPlanRevision;
    if (!pending) return {};
    const userText = getMessageText(findLastUserMessage(state.messages)).trim();

    if (pending.stage === 'confirm_changes') {
      if (CONFIRM_REGEX.test(userText)) {
        return {
          messages: [{
            role: 'ai',
            content: '好，这些变化确认清楚了。我会以这份清单作为新版依据，下一步重新核对需要计算的数据，再给你完整的新方案。',
          }],
          confirmedPlanRevisionRequest: {
            parentPlanId: pending.parentPlanId,
            parentPlanVersion: pending.parentPlanVersion,
            changes: pending.changes,
            confirmedAt: new Date().toISOString(),
          },
          pendingPlanRevision: null,
        };
      }
      if (REJECT_REGEX.test(userText)) {
        return {
          messages: [{ role: 'ai', content: '好，你直接告诉我哪一项需要修改，或者还漏了什么，我重新整理。' }],
          pendingPlanRevision: { ...pending, stage: 'collect_changes', askedCount: pending.askedCount + 1 },
        };
      }
      // 用户在确认时直接补充新信息，不要求其重新说“不是”。继续向下抽取，
      // 新值会按字段覆盖旧值，其余已经确认的变化保留。
    }

    const extracted = await extractor.invoke([
      {
        role: 'system',
        content:
          '用户正在说明为什么需要重新调整长期饮食计划。只提取用户明确说出的持续变化，' +
          '不要把一次吃多、一次运动、临时想吃某样东西当成长期变化。一次消息可以包含多项。' +
          'summary用自然中文忠实概括，不补充数字或原因。健康不适归health_status。' +
          '如果用户只说“变了”“不一样了”但没有说明具体哪里变化，changes留空并提出一个简短追问。',
      },
      { role: 'human', content: userText },
    ]);
    const changes = mergeChanges(pending.changes, extracted.changes);
    if (!changes.length || extracted.needsMoreDetail) {
      const askedCount = (pending.askedCount || 1) + 1;
      return {
        messages: [{
          role: 'ai',
          content: extracted.followUpQuestion || '我还需要知道具体是哪一方面发生了持续变化，才能避免把新版方向定错。',
        }],
        pendingPlanRevision: { ...pending, stage: 'collect_changes', changes, askedCount },
      };
    }

    return {
      messages: [{ role: 'ai', content: buildChangesConfirmation(changes) }],
      pendingPlanRevision: { ...pending, stage: 'confirm_changes', changes },
    };
  };
}

const resolvePlanRevision = createResolvePlanRevision();

module.exports = {
  CONFIRM_REGEX,
  REJECT_REGEX,
  RevisionChangesSchema,
  FIELD_LABELS,
  createRevisionChangeExtractor,
  mergeChanges,
  buildChangesConfirmation,
  startPlanRevision,
  createResolvePlanRevision,
  resolvePlanRevision,
};

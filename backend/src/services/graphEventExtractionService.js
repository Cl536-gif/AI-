const crypto = require('crypto');
const { z } = require('zod');
const { classifierModel } = require('../langgraph/model');

const EXTRACTABLE_EVENT_TYPES = [
  'meal',
  'snack',
  'body_measurement',
  'exercise',
  'check_in',
  'plan_interruption',
];

const ExtractedEventSchema = z.object({
  eventType: z.enum(EXTRACTABLE_EVENT_TYPES),
  occurredAt: z.string().datetime({ offset: true }),
  summary: z.string().min(1).max(500),
  mealType: z.enum(['breakfast', 'lunch', 'dinner', 'unknown']).nullable(),
  amountText: z.string().max(200).nullable(),
  durationMinutes: z.number().min(0).max(1440).nullable(),
  deviceEstimatedKcal: z.number().min(0).max(10000).nullable(),
  // 本次 body_measurement 事件发生时测得的体重（时间点值）。
  // 用户档案当前值使用 bodyProfile.currentWeightKg，两者不可混写。
  weightKg: z.number().min(10).max(500).nullable(),
  reason: z.string().max(500).nullable(),
});

const ExtractionResultSchema = z.object({
  events: z.array(ExtractedEventSchema).max(5),
});

function buildPayload(extracted, rawText) {
  const payload = { summary: extracted.summary, rawText };
  ['mealType', 'amountText', 'durationMinutes', 'deviceEstimatedKcal', 'weightKg', 'reason'].forEach((key) => {
    if (extracted[key] !== null && extracted[key] !== undefined && extracted[key] !== 'unknown') {
      payload[key] = extracted[key];
    }
  });
  return payload;
}

function buildIdempotencyKey(threadId, message, index) {
  const digest = crypto
    .createHash('sha256')
    .update(`${threadId}:${message}`)
    .digest('hex')
    .slice(0, 32);
  return `langgraph:${digest}:${index}`;
}

function createGraphEventExtractor({ model = classifierModel } = {}) {
  const structuredModel = model.withStructuredOutput(ExtractionResultSchema, {
    name: 'extract_user_events',
  });

  async function extract(message, {
    threadId,
    now = new Date().toISOString(),
    timezone = 'Asia/Shanghai',
  } = {}) {
    const text = String(message || '').trim();
    if (!text) return [];
    if (!threadId) throw new Error('事件抽取需要threadId生成幂等键');

    const result = await structuredModel.invoke([
      {
        role: 'system',
        content:
          '你负责从用户这一条消息中提取已经真实发生、正在发生，或已经确定会造成计划中断的长期事件。' +
          '只允许：meal正餐、snack零食/加餐、body_measurement实际测量、exercise已经完成的运动、' +
          'check_in实际饥饿/饱腹/身体感受反馈、plan_interruption已经发生或明确确定的旅行/生病/断联。\n\n' +
          '绝不能把下面内容记录成事件：用户提出的问题；秘书建议用户以后吃什么；“想吃/准备吃/可以吃吗”' +
          '等尚未发生的饮食；“打算运动/明天可能运动”等尚未完成的运动；建档时填写的年龄、身高、目标体重；' +
          '单纯确认“好的/对”；模型根据上下文猜测的事情。没有明确事件时events必须是空数组。\n\n' +
          '一条消息明确包含多个已经发生的事件时可以分别提取，最多5条。设备或手表热量只能保存为' +
          'deviceEstimatedKcal参考值。体重必须换算成公斤。occurredAt必须带时区；用户未说明具体时间时使用' +
          `消息时间${now}。当前时区是${timezone}。summary只概括用户明确说出的事实，不得补充推断。`,
      },
      { role: 'human', content: text },
    ]);

    return result.events.map((event, index) => ({
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: buildPayload(event, text),
      source: 'user',
      idempotencyKey: buildIdempotencyKey(threadId, text, index),
    }));
  }

  return { extract };
}

const defaultExtractor = createGraphEventExtractor();

module.exports = {
  EXTRACTABLE_EVENT_TYPES,
  ExtractedEventSchema,
  ExtractionResultSchema,
  buildPayload,
  buildIdempotencyKey,
  createGraphEventExtractor,
  extractGraphEvents: defaultExtractor.extract,
};

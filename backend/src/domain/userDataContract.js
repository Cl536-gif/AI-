const { z } = require('zod');

// 用户档案字段联动规则（严格拒绝 / fail closed）：
// 新增、删除或重命名档案字段时，必须在同一次变更中同步更新：
// 1. 本文件的 Zod 契约；2. PostgreSQL 建表/迁移脚本；
// 3. app.save_current_user_profile RPC 的字段白名单、映射和数据库快照；
// 4. 契约测试、RPC 正常路径测试和失败回滚测试。
// 任一处遗漏都应由 RPC 白名单拒绝，禁止临时放宽校验绕过。

const USER_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const UserIdSchema = z.string().trim().regex(USER_ID_REGEX, 'userId格式不正确');

const BodyProfileSchema = z.object({
    equationSex: z.enum(['female', 'male']).nullable().default(null),
    ageYears: z.number().min(14).max(100).nullable().default(null),
    heightCm: z.number().min(120).max(230).nullable().default(null),
    // 档案中的“当前体重”规范值：用于读取用户当前身体状态。
    // 单次称重必须追加为 body_measurement 事件的 payload.weightKg，
    // 不要把事件时间点值与该档案字段混写。
    currentWeightKg: z.number().min(10).max(500).nullable().default(null),
    targetWeightKg: z.number().min(10).max(500).nullable().default(null),
    dailyActivity: z.string().max(200).nullable().default(null),
    recentWeightChange: z.string().max(200).nullable().default(null),
});

const DietProfileSchema = z.object({
    scene: z.enum(['cafeteria', 'takeaway', 'mixed', 'unknown']).default('unknown'),
    cafeteriaMode: z.enum(['self_select', 'fixed_set', 'mixed', 'unknown']).default('unknown'),
    budgetCnyPerMeal: z.number().min(0).max(10000).nullable().default(null),
    tastePreferences: z.array(z.string().min(1).max(100)).max(100).default([]),
    restrictions: z.array(z.string().min(1).max(200)).max(100).default([]),
    goals: z.array(z.string().min(1).max(200)).max(50).default([]),
    exerciseBaseline: z.string().max(300).nullable().default(null),
});

const MenstrualTrackingSchema = z.object({
    applicability: z.enum(['applicable', 'not_applicable', 'unknown']).default('unknown'),
    status: z.enum(['pending', 'active', 'declined', 'unknown']).default('unknown'),
});

const UserProfileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  body: BodyProfileSchema.default({}),
  diet: DietProfileSchema.default({}),
  menstrualTracking: MenstrualTrackingSchema.default({}),
});

const BodyProfilePatchSchema = z.object({
  equationSex: z.enum(['female', 'male']).nullable().optional(),
  ageYears: z.number().min(14).max(100).nullable().optional(),
  heightCm: z.number().min(120).max(230).nullable().optional(),
  currentWeightKg: z.number().min(10).max(500).nullable().optional(),
  targetWeightKg: z.number().min(10).max(500).nullable().optional(),
  dailyActivity: z.string().max(200).nullable().optional(),
  recentWeightChange: z.string().max(200).nullable().optional(),
}).strict();

const DietProfilePatchSchema = z.object({
  scene: z.enum(['cafeteria', 'takeaway', 'mixed', 'unknown']).optional(),
  cafeteriaMode: z.enum(['self_select', 'fixed_set', 'mixed', 'unknown']).optional(),
  budgetCnyPerMeal: z.number().min(0).max(10000).nullable().optional(),
  tastePreferences: z.array(z.string().min(1).max(100)).max(100).optional(),
  restrictions: z.array(z.string().min(1).max(200)).max(100).optional(),
  goals: z.array(z.string().min(1).max(200)).max(50).optional(),
  exerciseBaseline: z.string().max(300).nullable().optional(),
}).strict();

const MenstrualTrackingPatchSchema = z.object({
  applicability: z.enum(['applicable', 'not_applicable', 'unknown']).optional(),
  status: z.enum(['pending', 'active', 'declined', 'unknown']).optional(),
}).strict();

const UserProfilePatchSchema = z.object({
  body: BodyProfilePatchSchema.optional(),
  diet: DietProfilePatchSchema.optional(),
  menstrualTracking: MenstrualTrackingPatchSchema.optional(),
}).strict();

const EVENT_TYPES = [
  'meal',
  'snack',
  'body_measurement',
  'exercise',
  'menstrual_period_start',
  'menstrual_symptom',
  'check_in',
  'plan_interruption',
  'user_correction',
];

const UserEventSchema = z.object({
  eventId: z.string().min(1).max(128).optional(),
  userId: UserIdSchema,
  eventType: z.enum(EVENT_TYPES),
  occurredAt: z.string().datetime({ offset: true }),
  recordedAt: z.string().datetime({ offset: true }).optional(),
  payload: z.record(z.string(), z.unknown()),
  source: z.enum(['user', 'secretary', 'device', 'import', 'system']).default('user'),
  idempotencyKey: z.string().min(1).max(200).nullable().optional(),
  supersedesEventId: z.string().min(1).max(128).nullable().optional(),
});

const ConsentSchema = z.object({
  userId: UserIdSchema,
  consentType: z.enum(['long_term_profile', 'menstrual_tracking', 'proactive_reminders']),
  status: z.enum(['granted', 'declined', 'revoked']),
  recordedAt: z.string().datetime({ offset: true }),
  source: z.enum(['user', 'system']).default('user'),
});

function createEmptyUserProfile() {
  return UserProfileSchema.parse({});
}

function deepMergeProfile(current, patch) {
  const validatedPatch = UserProfilePatchSchema.parse(patch);
  return UserProfileSchema.parse({
    ...current,
    ...validatedPatch,
    body: { ...current.body, ...(validatedPatch.body || {}) },
    diet: { ...current.diet, ...(validatedPatch.diet || {}) },
    menstrualTracking: {
      ...current.menstrualTracking,
      ...(validatedPatch.menstrualTracking || {}),
    },
  });
}

module.exports = {
  USER_ID_REGEX,
  EVENT_TYPES,
  UserIdSchema,
  BodyProfileSchema,
  DietProfileSchema,
  MenstrualTrackingSchema,
  BodyProfilePatchSchema,
  DietProfilePatchSchema,
  MenstrualTrackingPatchSchema,
  UserProfileSchema,
  UserProfilePatchSchema,
  UserEventSchema,
  ConsentSchema,
  createEmptyUserProfile,
  deepMergeProfile,
};

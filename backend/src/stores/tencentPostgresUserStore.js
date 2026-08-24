const {
  UserIdSchema,
  UserEventSchema,
  ConsentSchema,
  UserProfileSchema,
  UserProfilePatchSchema,
  createEmptyUserProfile,
  deepMergeProfile,
} = require('../domain/userDataContract');
const {
  withPostgresClient,
  withUserTransaction,
} = require('../db/postgresTransaction');
const { assertUserStore, USER_STORE_METHODS } = require('./userStoreContract');
const {
  DATABASE_READY_METHODS,
  assertCompleteCapabilityInventory,
} = require('./tencentPostgresUserStoreCapabilities');

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ACTIVE_EVENT_STATUS = 'active';
const CONSENT_TYPES = new Set([
  'long_term_profile',
  'menstrual_tracking',
  'proactive_reminders',
]);

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return null;
  const text = String(value);
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? text : new Date(timestamp).toISOString();
}

function normalizeRpcResult(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function firstRpcResult(queryResult) {
  return normalizeRpcResult(queryResult?.rows?.[0]?.result ?? null);
}

function mapUserSettings(userId, value) {
  if (!value) return null;
  return {
    userId,
    timezone: value.timezone || 'Asia/Shanghai',
    locale: value.locale || 'zh-CN',
    lastActiveAt: normalizeTimestamp(value.lastActiveAt ?? value.last_active_at),
    createdAt: normalizeTimestamp(value.createdAt ?? value.created_at),
  };
}

function mapServiceStatus(userId, value) {
  if (!value) return null;
  return {
    userId,
    status: value.status,
    trialStartedAt: normalizeTimestamp(
      value.trialStartedAt ?? value.trial_started_at
    ),
    trialEndsAt: normalizeTimestamp(value.trialEndsAt ?? value.trial_ends_at),
    renewalReminderAt: normalizeTimestamp(
      value.renewalReminderAt ?? value.renewal_reminder_at
    ),
    officialPlanId: value.officialPlanId ?? value.official_plan_id ?? null,
    updatedAt: normalizeTimestamp(value.updatedAt ?? value.updated_at),
  };
}

function mapEnergyCalculation(userId, value) {
  if (!value) return null;
  return {
    calculationId: value.calculationId ?? value.calculation_id,
    userId,
    formulaId: value.formulaId ?? value.formula_id,
    formulaVersion: value.formulaVersion ?? value.formula_version,
    inputs: value.inputs,
    assumptions: value.assumptions || [],
    outputs: value.outputs,
    sourceRefs: value.sourceRefs ?? value.source_refs ?? [],
    createdAt: normalizeTimestamp(value.createdAt ?? value.created_at),
  };
}

function mapPlan(userId, value) {
  if (!value) return null;
  return {
    planId: value.planId ?? value.plan_id,
    userId,
    planVersion: Number(value.planVersion ?? value.plan_version),
    status: value.status,
    calculationId: value.calculationId ?? value.calculation_id ?? null,
    parentPlanId: value.parentPlanId ?? value.parent_plan_id ?? null,
    plan: value.plan,
    changeReason: value.changeReason ?? value.change_reason,
    createdAt: normalizeTimestamp(value.createdAt ?? value.created_at),
    activatedAt: normalizeTimestamp(value.activatedAt ?? value.activated_at),
    pausedAt: normalizeTimestamp(value.pausedAt ?? value.paused_at),
    completedAt: normalizeTimestamp(value.completedAt ?? value.completed_at),
  };
}

function mapPlanTransition(userId, planId, value) {
  if (!value) return null;
  return {
    transitionId: value.transitionId ?? value.transition_id,
    planId,
    userId,
    fromStatus: value.fromStatus ?? value.from_status ?? null,
    toStatus: value.toStatus ?? value.to_status,
    reason: value.reason,
    occurredAt: normalizeTimestamp(value.occurredAt ?? value.occurred_at),
  };
}

function mapEventRow(userId, row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    userId,
    eventType: row.event_type,
    occurredAt: normalizeTimestamp(row.occurred_at),
    recordedAt: normalizeTimestamp(row.recorded_at),
    payload: row.payload,
    source: row.source,
    idempotencyKey: row.idempotency_key ?? null,
    supersedesEventId: row.supersedes_event_id ?? null,
    status: row.status || ACTIVE_EVENT_STATUS,
  };
}

function mapRpcEvent(userId, value) {
  if (!value) return null;
  return {
    eventId: value.eventId,
    userId,
    eventType: value.eventType,
    occurredAt: normalizeTimestamp(value.occurredAt),
    recordedAt: normalizeTimestamp(value.recordedAt),
    payload: value.payload,
    source: value.source,
    idempotencyKey: value.idempotencyKey ?? null,
    supersedesEventId: value.supersedesEventId ?? null,
    status: ACTIVE_EVENT_STATUS,
  };
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function profileFromRow(row) {
  const empty = createEmptyUserProfile();
  if (!row) return empty;
  return UserProfileSchema.parse({
    schemaVersion: Number(row.schema_version || 1),
    body: {
      equationSex: row.equation_sex ?? null,
      ageYears: numberOrNull(row.age_years),
      heightCm: numberOrNull(row.height_cm),
      currentWeightKg: numberOrNull(row.current_weight_kg),
      targetWeightKg: numberOrNull(row.target_weight_kg),
      dailyActivity: row.daily_activity ?? null,
      recentWeightChange: row.recent_weight_change ?? null,
    },
    diet: {
      scene: row.scene || 'unknown',
      cafeteriaMode: row.cafeteria_mode || 'unknown',
      budgetCnyPerMeal: numberOrNull(row.budget_cny_per_meal),
      tastePreferences: row.taste_preferences || [],
      restrictions: row.restrictions || [],
      goals: row.goals || [],
      exerciseBaseline: row.exercise_baseline ?? null,
    },
    menstrualTracking: row.menstrual_snapshot || (
      row.menstrual_applicability || row.menstrual_status
        ? {
          applicability: row.menstrual_applicability || 'unknown',
          status: row.menstrual_status || 'unknown',
        }
        : empty.menstrualTracking
    ),
  });
}

const PROFILE_SELECT_SQL = 'SELECT versions.current_version, versions.created_at AS version_created_at, versions.updated_at AS version_updated_at, profile.schema_version, profile.equation_sex, profile.age_years, profile.height_cm, profile.current_weight_kg, profile.target_weight_kg, profile.daily_activity, profile.recent_weight_change, profile.scene, profile.cafeteria_mode, profile.budget_cny_per_meal, profile.taste_preferences, profile.restrictions, profile.goals, profile.exercise_baseline, menstrual.applicability AS menstrual_applicability, menstrual.status AS menstrual_status FROM app.user_profile_versions AS versions LEFT JOIN app.user_profiles AS profile ON profile.user_id = versions.user_id LEFT JOIN app.user_menstrual_profiles AS menstrual ON menstrual.user_id = versions.user_id WHERE versions.user_id = $1 LIMIT 1';

async function queryProfileRecord(client, userId) {
  const result = await client.query(PROFILE_SELECT_SQL, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId,
    profileVersion: Number(row.current_version),
    profile: profileFromRow(row),
    createdAt: normalizeTimestamp(row.version_created_at),
    updatedAt: normalizeTimestamp(row.version_updated_at),
  };
}

function unavailableMethod(methodName) {
  return async function postgresUserStoreMethodUnavailable() {
    const error = new Error(`TencentPostgresUserStore.${methodName} 尚未完成004契约验收`);
    error.code = 'POSTGRES_USER_STORE_METHOD_UNAVAILABLE';
    error.methodName = methodName;
    throw error;
  };
}

function createTencentPostgresUserStore({
  runUserTransaction = withUserTransaction,
  runPostgresClient = withPostgresClient,
} = {}) {
  if (typeof runUserTransaction !== 'function' || typeof runPostgresClient !== 'function') {
    throw new TypeError('创建TencentPostgresUserStore需要有效的PostgreSQL事务执行器');
  }
  assertCompleteCapabilityInventory();

  async function ensureUser(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    await runUserTransaction(normalizedUserId, async (client) => {
      await client.query(
        "INSERT INTO app.users (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING",
        [normalizedUserId]
      );
    });
    return normalizedUserId;
  }

  async function resolveAnonymousIdentity(externalSubjectHash) {
    const normalizedHash = String(externalSubjectHash || '').trim().toLowerCase();
    if (!SHA256_HEX.test(normalizedHash)) {
      throw new Error('匿名身份摘要格式不正确');
    }
    return runPostgresClient(async (client) => {
      const result = await client.query(
        'SELECT app.resolve_anonymous_identity($1, $2) AS result',
        ['device_sha256', normalizedHash]
      );
      return firstRpcResult(result)?.userId || null;
    });
  }

  async function mergeAnonymousIntoAccount(sourceUserId, authenticatedAccountId) {
    const source = UserIdSchema.parse(sourceUserId);
    const accountSubject = UserIdSchema.parse(authenticatedAccountId);
    if (!source.startsWith('anon:')) throw new Error('只能合并匿名游客身份');
    if (accountSubject.startsWith('anon:') || accountSubject.startsWith('acct:')) {
      throw new Error('authenticatedAccountId必须是认证系统提供的原始账号标识');
    }
    const targetUserId = UserIdSchema.parse(`acct:${accountSubject}`);
    return runUserTransaction(targetUserId, async (client) => {
      const result = await client.query(
        'SELECT app.merge_current_account_from_anonymous($1) AS result',
        [source]
      );
      return firstRpcResult(result);
    });
  }

  async function releaseMergedSensitiveEvents(userId, mergeId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedMergeId = String(mergeId || '').trim();
    if (!normalizedMergeId) throw new Error('mergeId不能为空');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.release_current_merged_sensitive_events($1::uuid) AS result',
        [normalizedMergeId]
      );
      return Number(firstRpcResult(result));
    });
  }

  async function getProfile(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return runUserTransaction(
      normalizedUserId,
      (client) => queryProfileRecord(client, normalizedUserId)
    );
  }

  async function updateProfile(userId, patch, {
    source = 'user',
    expectedVersion = null,
  } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const validatedPatch = UserProfilePatchSchema.parse(patch);
    const changedFields = Object.keys(validatedPatch);
    if (changedFields.length === 0) throw new Error('档案补丁没有可更新字段');
    if (
      expectedVersion !== null
      && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    ) {
      throw new Error('expectedVersion必须是非负整数或null');
    }

    return runUserTransaction(normalizedUserId, async (client) => {
      const current = await queryProfileRecord(client, normalizedUserId);
      const nextProfile = deepMergeProfile(
        current?.profile || createEmptyUserProfile(),
        validatedPatch
      );
      const result = await client.query(
        'SELECT app.save_current_user_profile_versioned($1::jsonb, $2, $3, $4::jsonb) AS result',
        [
          JSON.stringify(nextProfile),
          source,
          expectedVersion,
          JSON.stringify(changedFields),
        ]
      );
      const saved = firstRpcResult(result);
      if (!saved) throw new Error('PostgreSQL档案保存未返回结果');
      return {
        userId: normalizedUserId,
        profileVersion: Number(saved.profileVersion),
        profile: UserProfileSchema.parse(saved.profile),
        createdAt: normalizeTimestamp(saved.createdAt),
        updatedAt: normalizeTimestamp(saved.updatedAt),
      };
    });
  }

  async function listProfileRevisions(userId, { limit = 50 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT history.profile_version, history.normal_revision_id, history.menstrual_revision_id, history.changed_fields, history.source, history.recorded_at, normal_revision.profile_snapshot, menstrual_revision.menstrual_snapshot FROM app.user_profile_version_history AS history LEFT JOIN LATERAL (SELECT revision.profile_snapshot FROM app.user_profile_version_history AS normal_history JOIN app.profile_revisions AS revision ON revision.user_id = normal_history.user_id AND revision.revision_id = normal_history.normal_revision_id WHERE normal_history.user_id = history.user_id AND normal_history.profile_version <= history.profile_version AND normal_history.normal_revision_id IS NOT NULL ORDER BY normal_history.profile_version DESC LIMIT 1) AS normal_revision ON true LEFT JOIN LATERAL (SELECT revision.menstrual_snapshot FROM app.user_profile_version_history AS menstrual_history JOIN app.menstrual_profile_revisions AS revision ON revision.user_id = menstrual_history.user_id AND revision.revision_id = menstrual_history.menstrual_revision_id WHERE menstrual_history.user_id = history.user_id AND menstrual_history.profile_version <= history.profile_version AND menstrual_history.menstrual_revision_id IS NOT NULL ORDER BY menstrual_history.profile_version DESC LIMIT 1) AS menstrual_revision ON true WHERE history.user_id = $1 ORDER BY history.profile_version DESC LIMIT $2',
        [normalizedUserId, safeLimit]
      );
      return result.rows.map((row) => {
        const normalProfile = row.profile_snapshot || createEmptyUserProfile();
        const snapshot = UserProfileSchema.parse({
          ...normalProfile,
          menstrualTracking: row.menstrual_snapshot ||
            createEmptyUserProfile().menstrualTracking,
        });
        return {
          revisionId: String(row.normal_revision_id || row.menstrual_revision_id),
          userId: normalizedUserId,
          profileVersion: Number(row.profile_version),
          snapshot,
          changedFields: row.changed_fields || [],
          source: row.source,
          createdAt: normalizeTimestamp(row.recorded_at),
        };
      });
    });
  }

  async function recordActivity(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.record_current_user_activity() AS result',
        []
      );
      const activity = firstRpcResult(result);
      if (!activity?.now) throw new Error('PostgreSQL活跃时间写入未返回结果');
      return {
        previousActiveAt: normalizeTimestamp(activity.previousActiveAt),
        now: normalizeTimestamp(activity.now),
      };
    });
  }

  async function getUserSettings(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT timezone, locale, last_active_at, created_at FROM app.users WHERE user_id = $1 LIMIT 1',
        [normalizedUserId]
      );
      return mapUserSettings(normalizedUserId, result.rows[0]);
    });
  }

  async function updateUserTimezone(userId, timezone) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedTimezone = String(timezone || '').trim();
    if (!normalizedTimezone) throw new Error('用户时区格式不正确');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.update_current_user_timezone($1) AS result',
        [normalizedTimezone]
      );
      const settings = mapUserSettings(normalizedUserId, firstRpcResult(result));
      if (!settings) throw new Error('PostgreSQL用户时区更新未返回结果');
      return settings;
    });
  }

  async function getServiceStatus(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT status, trial_started_at, trial_ends_at, renewal_reminder_at, official_plan_id, updated_at FROM app.user_service_status WHERE user_id = $1 LIMIT 1',
        [normalizedUserId]
      );
      return mapServiceStatus(normalizedUserId, result.rows[0]);
    });
  }

  async function setServiceStatus(userId, next, { reason = 'unspecified' } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('服务状态参数格式不正确');
    }
    const payload = {
      status: next.status,
      trialStartedAt: next.trialStartedAt ?? null,
      trialEndsAt: next.trialEndsAt ?? null,
      renewalReminderAt: next.renewalReminderAt ?? null,
      officialPlanId: next.officialPlanId ?? null,
    };
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.set_current_user_service_status($1::jsonb, $2) AS result',
        [JSON.stringify(payload), String(reason || 'unspecified')]
      );
      const status = mapServiceStatus(normalizedUserId, firstRpcResult(result));
      if (!status) throw new Error('PostgreSQL服务状态写入未返回结果');
      return status;
    });
  }

  async function listServiceTransitions(userId, { limit = 50 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT transition_id, from_status, to_status, reason, occurred_at FROM app.user_service_transitions WHERE user_id = $1 ORDER BY occurred_at DESC, transition_id DESC LIMIT $2',
        [normalizedUserId, safeLimit]
      );
      return result.rows.map((row) => ({
        transitionId: row.transition_id,
        userId: normalizedUserId,
        fromStatus: row.from_status ?? null,
        toStatus: row.to_status,
        reason: row.reason,
        occurredAt: normalizeTimestamp(row.occurred_at),
      }));
    });
  }

  async function recordEnergyCalculation(userId, calculation, {
    now = new Date().toISOString(),
  } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    if (!calculation || typeof calculation !== 'object' || Array.isArray(calculation)) {
      throw new Error('能量计算记录格式不正确');
    }
    const createdAt = new Date(now);
    if (Number.isNaN(createdAt.getTime())) throw new Error('能量计算时间格式不正确');
    const payload = {
      formulaId: calculation.formulaId,
      formulaVersion: calculation.formulaVersion,
      inputs: calculation.inputs,
      assumptions: calculation.assumptions || [],
      outputs: calculation.outputs,
      sourceRefs: calculation.sourceRefs || [],
    };
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.record_current_user_energy_calculation($1::jsonb, $2::timestamptz) AS result',
        [JSON.stringify(payload), createdAt.toISOString()]
      );
      const saved = mapEnergyCalculation(normalizedUserId, firstRpcResult(result));
      if (!saved) throw new Error('PostgreSQL能量计算写入未返回结果');
      return saved;
    });
  }

  async function listEnergyCalculations(userId, { limit = 20 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT calculation_id, formula_id, formula_version, inputs, assumptions, outputs, source_refs, created_at FROM app.energy_calculations WHERE user_id = $1 ORDER BY created_at DESC, calculation_id DESC LIMIT $2',
        [normalizedUserId, safeLimit]
      );
      return result.rows.map((row) => mapEnergyCalculation(normalizedUserId, row));
    });
  }

  async function getPlan(userId, planId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedPlanId = String(planId || '').trim();
    if (!normalizedPlanId) throw new Error('planId不能为空');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT plan_id, plan_version, status, calculation_id, parent_plan_id, plan, change_reason, created_at, activated_at, paused_at, completed_at FROM app.user_plan_versions WHERE user_id = $1 AND plan_id = $2 LIMIT 1',
        [normalizedUserId, normalizedPlanId]
      );
      return mapPlan(normalizedUserId, result.rows[0]);
    });
  }

  async function getActivePlan(userId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        "SELECT plan_id, plan_version, status, calculation_id, parent_plan_id, plan, change_reason, created_at, activated_at, paused_at, completed_at FROM app.user_plan_versions WHERE user_id = $1 AND status = 'active' LIMIT 1",
        [normalizedUserId]
      );
      return mapPlan(normalizedUserId, result.rows[0]);
    });
  }

  async function listPlans(userId, { limit = 50 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT plan_id, plan_version, status, calculation_id, parent_plan_id, plan, change_reason, created_at, activated_at, paused_at, completed_at FROM app.user_plan_versions WHERE user_id = $1 ORDER BY plan_version DESC LIMIT $2',
        [normalizedUserId, safeLimit]
      );
      return result.rows.map((row) => mapPlan(normalizedUserId, row));
    });
  }

  async function createPlanDraft(userId, input, {
    now = new Date().toISOString(),
  } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('计划草稿参数格式不正确');
    }
    const createdAt = new Date(now);
    if (Number.isNaN(createdAt.getTime())) throw new Error('计划草稿时间格式不正确');
    const payload = {
      calculationId: input.calculationId ?? null,
      parentPlanId: input.parentPlanId ?? null,
      plan: input.plan,
      changeReason: input.changeReason,
    };
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.create_current_user_plan_draft($1::jsonb, $2::timestamptz) AS result',
        [JSON.stringify(payload), createdAt.toISOString()]
      );
      const saved = mapPlan(normalizedUserId, firstRpcResult(result));
      if (!saved) throw new Error('PostgreSQL计划草稿写入未返回结果');
      return saved;
    });
  }

  async function transitionPlan(userId, planId, toStatus, {
    reason = 'unspecified',
    now = new Date().toISOString(),
  } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedPlanId = String(planId || '').trim();
    const normalizedStatus = String(toStatus || '').trim();
    if (!normalizedPlanId) throw new Error('planId不能为空');
    if (!normalizedStatus) throw new Error('计划目标状态不能为空');
    const occurredAt = new Date(now);
    if (Number.isNaN(occurredAt.getTime())) throw new Error('计划转换时间格式不正确');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.transition_current_user_plan($1, $2, $3, $4::timestamptz) AS result',
        [
          normalizedPlanId,
          normalizedStatus,
          String(reason || 'unspecified'),
          occurredAt.toISOString(),
        ]
      );
      const saved = mapPlan(normalizedUserId, firstRpcResult(result));
      if (!saved) throw new Error('PostgreSQL计划状态转换未返回结果');
      return saved;
    });
  }

  async function activateInitialPlanAndTrial(userId, planId, {
    trialStartedAt,
    trialEndsAt,
    renewalReminderAt,
  } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedPlanId = String(planId || '').trim();
    if (!normalizedPlanId) throw new Error('正式计划ID不能为空');
    const timestamps = {
      trialStartedAt: new Date(trialStartedAt),
      trialEndsAt: new Date(trialEndsAt),
      renewalReminderAt: new Date(renewalReminderAt),
    };
    for (const [label, value] of Object.entries(timestamps)) {
      if (Number.isNaN(value.getTime())) throw new Error(`${label}格式不正确`);
    }
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT app.activate_current_user_initial_plan_and_trial($1, $2::timestamptz, $3::timestamptz, $4::timestamptz) AS result',
        [
          normalizedPlanId,
          timestamps.trialStartedAt.toISOString(),
          timestamps.trialEndsAt.toISOString(),
          timestamps.renewalReminderAt.toISOString(),
        ]
      );
      const saved = mapPlan(normalizedUserId, firstRpcResult(result));
      if (!saved) throw new Error('PostgreSQL首个计划与体验激活未返回结果');
      return saved;
    });
  }

  async function listPlanTransitions(userId, planId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedPlanId = String(planId || '').trim();
    if (!normalizedPlanId) throw new Error('planId不能为空');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT transition_id, from_status, to_status, reason, occurred_at FROM app.plan_state_transitions WHERE user_id = $1 AND plan_id = $2 ORDER BY occurred_at DESC, transition_id DESC',
        [normalizedUserId, normalizedPlanId]
      );
      return result.rows.map((row) => (
        mapPlanTransition(normalizedUserId, normalizedPlanId, row)
      ));
    });
  }

  async function appendEvent(input) {
    const parsed = UserEventSchema.parse(input);
    const { userId, ...event } = parsed;
    return runUserTransaction(userId, async (client) => {
      await client.query(
        "INSERT INTO app.users (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING",
        [userId]
      );
      const result = await client.query(
        'SELECT app.append_current_user_event($1::jsonb) AS result',
        [JSON.stringify(event)]
      );
      return mapRpcEvent(userId, firstRpcResult(result));
    });
  }

  async function getEvent(userId, eventId) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedEventId = String(eventId || '').trim();
    if (!normalizedEventId) throw new Error('eventId不能为空');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        "SELECT event_id, event_type, occurred_at, recorded_at, payload, source, idempotency_key, supersedes_event_id, status FROM app.user_events WHERE user_id = $1 AND event_id = $2 AND status = 'active' LIMIT 1",
        [normalizedUserId, normalizedEventId]
      );
      return mapEventRow(normalizedUserId, result.rows[0]);
    });
  }

  async function listEvents(userId, { eventType = null, limit = 100 } = {}) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const normalizedEventType = eventType == null ? null : String(eventType).trim();
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = normalizedEventType
        ? await client.query(
          "SELECT event_id, event_type, occurred_at, recorded_at, payload, source, idempotency_key, supersedes_event_id, status FROM app.user_events WHERE user_id = $1 AND event_type = $2 AND status = 'active' ORDER BY occurred_at DESC, event_id DESC LIMIT $3",
          [normalizedUserId, normalizedEventType, safeLimit]
        )
        : await client.query(
          "SELECT event_id, event_type, occurred_at, recorded_at, payload, source, idempotency_key, supersedes_event_id, status FROM app.user_events WHERE user_id = $1 AND status = 'active' ORDER BY occurred_at DESC, event_id DESC LIMIT $2",
          [normalizedUserId, safeLimit]
        );
      return result.rows.map((row) => mapEventRow(normalizedUserId, row));
    });
  }

  async function recordConsent(input) {
    const parsed = ConsentSchema.parse(input);
    const { userId, ...consent } = parsed;
    return runUserTransaction(userId, async (client) => {
      await client.query(
        "INSERT INTO app.users (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING",
        [userId]
      );
      const result = await client.query(
        'SELECT app.record_current_user_consent($1::jsonb) AS result',
        [JSON.stringify(consent)]
      );
      return firstRpcResult(result);
    });
  }

  async function getLatestConsent(userId, consentType) {
    const normalizedUserId = UserIdSchema.parse(userId);
    const normalizedConsentType = String(consentType || '').trim();
    if (!CONSENT_TYPES.has(normalizedConsentType)) throw new Error('授权类型不正确');
    return runUserTransaction(normalizedUserId, async (client) => {
      const result = await client.query(
        'SELECT consent_type, status, recorded_at, source FROM app.user_consents WHERE user_id = $1 AND consent_type = $2 ORDER BY created_at DESC, consent_id DESC LIMIT 1',
        [normalizedUserId, normalizedConsentType]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        userId: normalizedUserId,
        consentType: row.consent_type,
        status: row.status,
        recordedAt: normalizeTimestamp(row.recorded_at),
        source: row.source,
      };
    });
  }

  const implementedMethods = {
    ensureUser,
    resolveAnonymousIdentity,
    mergeAnonymousIntoAccount,
    releaseMergedSensitiveEvents,
    getProfile,
    updateProfile,
    listProfileRevisions,
    recordActivity,
    getUserSettings,
    updateUserTimezone,
    getServiceStatus,
    setServiceStatus,
    listServiceTransitions,
    recordEnergyCalculation,
    listEnergyCalculations,
    createPlanDraft,
    getPlan,
    getActivePlan,
    listPlans,
    transitionPlan,
    activateInitialPlanAndTrial,
    listPlanTransitions,
    appendEvent,
    getEvent,
    listEvents,
    recordConsent,
    getLatestConsent,
  };
  const store = {};
  for (const methodName of USER_STORE_METHODS) {
    store[methodName] = implementedMethods[methodName] || unavailableMethod(methodName);
  }
  store.close = async () => {};

  if (!DATABASE_READY_METHODS.every((methodName) => implementedMethods[methodName])) {
    throw new Error('TencentPostgresUserStore遗漏数据库已就绪方法');
  }
  return assertUserStore(store, { adapterName: 'TencentPostgresUserStore' });
}

module.exports = {
  createTencentPostgresUserStore,
};

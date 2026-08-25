const userService = require('./userService');
const { getUserStore } = require('../stores/userStoreProvider');

function normalizeScene(value) {
  const text = String(value || '');
  const hasCafeteria = /食堂|饭堂|打饭/.test(text);
  const hasTakeaway = /外卖|点餐|叫餐/.test(text);
  if (hasCafeteria && hasTakeaway) return 'mixed';
  if (hasCafeteria) return 'cafeteria';
  if (hasTakeaway) return 'takeaway';
  return 'unknown';
}

function normalizeCafeteriaMode(value) {
  const text = String(value || '');
  const hasSelfSelect = /自己挑菜|自选|自己选菜/.test(text);
  const hasFixedSet = /固定套餐|配好|套餐/.test(text);
  if (hasSelfSelect && hasFixedSet) return 'mixed';
  if (hasSelfSelect) return 'self_select';
  if (hasFixedSet) return 'fixed_set';
  return 'unknown';
}

function normalizeBudget(value) {
  const match = String(value || '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function confirmedSlotValue(slots, key) {
  const slot = slots?.[key];
  return slot?.confirmed && slot.value ? String(slot.value).trim() : null;
}

function buildProfilePatchFromGraphState(state) {
  const slots = state?.slots || {};
  const scene = confirmedSlotValue(slots, 'scene');
  const cafeteriaMode = confirmedSlotValue(slots, 'cafeteriaMode');
  const budget = confirmedSlotValue(slots, 'budget');
  const taste = confirmedSlotValue(slots, 'taste');
  const restrictions = confirmedSlotValue(slots, 'restrictions');
  const goal = confirmedSlotValue(slots, 'goal');
  const exercise = confirmedSlotValue(slots, 'exercise');
  const bodyProfile = state?.bodyProfile || {};
  const patch = {};

  const diet = {};
  if (scene) diet.scene = normalizeScene(scene);
  if (cafeteriaMode) diet.cafeteriaMode = normalizeCafeteriaMode(cafeteriaMode);
  if (budget) diet.budgetCnyPerMeal = normalizeBudget(budget);
  if (taste) diet.tastePreferences = [taste];
  if (restrictions) diet.restrictions = [restrictions];
  if (goal) diet.goals = [goal];
  if (exercise) diet.exerciseBaseline = exercise;
  if (Object.keys(diet).length > 0) patch.diet = diet;

  const allowedBodyKeys = [
    'equationSex',
    'ageYears',
    'heightCm',
    'currentWeightKg',
    'targetWeightKg',
    'dailyActivity',
    'recentWeightChange',
  ];
  const body = {};
  allowedBodyKeys.forEach((key) => {
    if (bodyProfile[key] !== undefined && bodyProfile[key] !== null && bodyProfile[key] !== '') {
      body[key] = bodyProfile[key];
    }
  });
  if (state?.equationSex) body.equationSex = state.equationSex;
  if (Object.keys(body).length > 0) patch.body = body;

  return patch;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeUnchangedFields(currentProfile, patch) {
  const changed = {};
  Object.entries(patch).forEach(([section, fields]) => {
    const sectionChanges = {};
    Object.entries(fields).forEach(([key, value]) => {
      if (!valuesEqual(currentProfile?.[section]?.[key], value)) sectionChanges[key] = value;
    });
    if (Object.keys(sectionChanges).length > 0) changed[section] = sectionChanges;
  });
  return changed;
}

async function persistGraphProfile(userId, state, { store = getUserStore(), now = new Date().toISOString() } = {}) {
  const candidatePatch = buildProfilePatchFromGraphState(state);
  if (Object.keys(candidatePatch).length === 0) {
    return { status: 'unchanged', profile: await userService.getProfile(userId, { store }) };
  }

  const current = await userService.getProfile(userId, { store });
  const changedPatch = removeUnchangedFields(current?.profile, candidatePatch);
  if (Object.keys(changedPatch).length === 0) return { status: 'unchanged', profile: current };

  const profile = await userService.updateProfile(userId, changedPatch, {
    store,
    source: 'langgraph',
    now,
    expectedVersion: current?.profileVersion || 0,
  });
  return { status: 'updated', profile };
}

module.exports = {
  normalizeScene,
  normalizeCafeteriaMode,
  normalizeBudget,
  buildProfilePatchFromGraphState,
  removeUnchangedFields,
  persistGraphProfile,
};

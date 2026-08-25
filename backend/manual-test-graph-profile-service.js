const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore } = require('./src/services/userStore');
const {
  buildProfilePatchFromGraphState,
  persistGraphProfile,
} = require('./src/services/graphProfileService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-graph-profile-'));
  const store = createUserStore({ dbPath: path.join(tempDir, 'test.db') });
  const userId = 'anon:11111111-1111-4111-8111-111111111111';
  store.ensureUser(userId, { now: '2026-08-05T12:00:00+08:00' });

  const graphState = {
    slots: {
      scene: { value: '食堂和外卖混着吃', confirmed: true },
      cafeteriaMode: { value: '自己挑菜', confirmed: true },
      taste: { value: '喜欢锅包肉，也喜欢重口味', confirmed: true },
      budget: { value: '每顿30元左右', confirmed: true },
      restrictions: { value: '不吃酸奶，吃了会腹泻', confirmed: true },
      goal: { value: '希望拍照更上镜', confirmed: true },
      exercise: { value: '偶尔攀岩，每周一节体育课', confirmed: true },
    },
    bodyProfile: {},
    menstrualProfile: { userReportedText: '不应写入普通档案' },
  };

  const patch = buildProfilePatchFromGraphState(graphState);
  assert(patch.diet.scene === 'mixed', '混合就餐场景规范化错误');
  assert(patch.diet.cafeteriaMode === 'self_select', '食堂模式规范化错误');
  assert(patch.diet.budgetCnyPerMeal === 30, '预算数字规范化错误');
  assert(!patch.menstrualTracking, '未经授权的经期信息进入了普通档案补丁');

  const firstWrite = await persistGraphProfile(userId, graphState, {
    store,
    now: '2026-08-05T12:10:00+08:00',
  });
  assert(firstWrite.status === 'updated', '首次已确认档案没有写入');
  assert(firstWrite.profile.profileVersion === 1, '首次档案版本错误');
  assert(firstWrite.profile.profile.diet.tastePreferences.length === 1, '口味没有写入档案');

  const repeatedWrite = await persistGraphProfile(userId, graphState, {
    store,
    now: '2026-08-05T12:20:00+08:00',
  });
  assert(repeatedWrite.status === 'unchanged', '相同状态产生了重复档案版本');
  assert(store.listProfileRevisions(userId).length === 1, '相同状态产生了重复历史快照');

  graphState.bodyProfile = {
    ageYears: 22,
    heightCm: 165,
    currentWeightKg: 60,
    targetWeightKg: 55,
    dailyActivity: '久坐为主',
  };
  const bodyWrite = await persistGraphProfile(userId, graphState, {
    store,
    now: '2026-08-05T12:30:00+08:00',
  });
  assert(bodyWrite.status === 'updated', '身体数据没有写入');
  assert(bodyWrite.profile.profileVersion === 2, '身体数据更新版本错误');
  assert(bodyWrite.profile.profile.body.currentWeightKg === 60, '当前体重没有写入');

  const unconfirmedState = {
    slots: {
      taste: { value: '模型猜测喜欢辣', confirmed: false },
    },
  };
  const unconfirmedPatch = buildProfilePatchFromGraphState(unconfirmedState);
  assert(Object.keys(unconfirmedPatch).length === 0, '未确认信息进入了档案补丁');

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✅ 已确认六项信息规范化并写入匿名基础档案');
  console.log('✅ 相同状态不会产生重复档案版本');
  console.log('✅ 身体数据可后续补充并形成新版本');
  console.log('✅ 未确认信息和经期敏感信息不会进入普通档案');
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

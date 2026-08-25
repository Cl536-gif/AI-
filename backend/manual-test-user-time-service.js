const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_TIMEZONE,
  detectExplicitTimezone,
  detectExplicitMealTarget,
  formatTemporalContext,
} = require('./src/services/userTimeService');
const { createUserStore } = require('./src/services/userStore');

const instant = '2026-08-07T07:00:00.000Z';
const shanghai = formatTemporalContext(instant, DEFAULT_TIMEZONE);
assert.deepStrictEqual(
  { date: shanghai.localDate, weekday: shanghai.weekday, time: shanghai.localTime },
  { date: '2026-08-07', weekday: '星期五', time: '15:00:00' },
);

const newYork = formatTemporalContext(instant, 'America/New_York');
assert.deepStrictEqual(
  { date: newYork.localDate, weekday: newYork.weekday, time: newYork.localTime },
  { date: '2026-08-07', weekday: '星期五', time: '03:00:00' },
);

assert.strictEqual(detectExplicitTimezone('我现在在纽约，按当地时间提醒我'), 'America/New_York');
assert.strictEqual(detectExplicitTimezone('我想吃纽约披萨'), null);
assert.strictEqual(detectExplicitTimezone('以后按Asia/Tokyo时间安排'), 'Asia/Tokyo');
assert.strictEqual(shanghai.mealTiming.currentWindow, 'between_lunch_and_dinner');
assert.strictEqual(shanghai.mealTiming.suggestedMeal, 'dinner');
assert.deepStrictEqual(detectExplicitMealTarget('今晚吃什么'), { meal: 'dinner', label: '晚餐' });
assert.deepStrictEqual(detectExplicitMealTarget('早餐想吃鸡蛋'), { meal: 'breakfast', label: '早餐' });
assert.strictEqual(detectExplicitMealTarget('我晚上容易饿'), null);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diet-user-time-'));
const store = createUserStore({ dbPath: path.join(tempDir, 'user-data.sqlite') });
const userId = 'anon:time_test_user';
store.ensureUser(userId, { now: instant });
assert.strictEqual(store.getUserSettings(userId).timezone, 'Asia/Shanghai');
store.updateUserTimezone(userId, 'America/New_York', { now: instant });
assert.strictEqual(store.getUserSettings(userId).timezone, 'America/New_York');
store.close();

console.log('PASS 默认北京时间：2026-08-07 星期五 15:00:00');
console.log('PASS 用户明确切换纽约时区：2026-08-07 星期五 03:00:00');
console.log('PASS 普通“纽约披萨”不会误改时区');
console.log('PASS 用户时区可写入并从档案读取');
console.log('PASS 当地时间可确定当前时段和下一餐，用户明确餐次优先');

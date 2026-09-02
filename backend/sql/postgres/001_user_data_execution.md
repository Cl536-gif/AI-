# 第一批用户数据迁移执行说明

## 本批范围

- 用户身份：`app.users`
- 普通当前档案：`app.user_profiles`
- 经期当前档案：`app.user_menstrual_profiles`
- 普通档案修订：`app.profile_revisions`
- 经期档案修订：`app.menstrual_profile_revisions`
- 追加式授权：`app.user_consents`
- 追加式事件：`app.user_events`

提醒、订阅、方案生命周期和 RAG 文档不在本批，后续逐批审核迁移。

## 字段映射

JavaScript 契约使用 camelCase，PostgreSQL 使用 snake_case：

- `equationSex` → `equation_sex`
- `ageYears` → `age_years`
- `heightCm` → `height_cm`
- `currentWeightKg` → `current_weight_kg`
- `targetWeightKg` → `target_weight_kg`
- `dailyActivity` → `daily_activity`
- `recentWeightChange` → `recent_weight_change`
- `cafeteriaMode` → `cafeteria_mode`
- `budgetCnyPerMeal` → `budget_cny_per_meal`
- `tastePreferences` → `taste_preferences`
- `exerciseBaseline` → `exercise_baseline`

`current_weight_kg` 是档案当前值；单次测量值写入 `body_measurement` 事件的 `payload.weightKg`。

## 已知临时宽松点

`meal`、`exercise` 等事件的 `payload` 当前故意保留为 JSON 对象，只执行以下数据库硬约束：

- 必须是 JSON object；
- 最大 50 KiB；
- `event_type`、`source` 使用白名单；
- 必须属于当前用户；
- 幂等键防重；
- 纠错事件必须指向同一用户的旧事件；
- 经期事件必须存在当前有效的独立授权。

后续会为各事件类型增加版本化 payload schema。这是明确记录的阶段性设计，不代表已经完成字段级安全校验。

## 经期授权决定

经期授权撤回后，历史数据保留，但业务角色不能读取或新增。重新授权后允许恢复使用历史数据。数据库 RLS 与业务层必须共同执行这条规则。

## 执行顺序

在腾讯云 DMC 中确认当前数据库是 `diet_secretary`，当前用户是 `admin_rag`，然后逐个完整执行：

1. `001a_user_data_core.sql`
2. `001b_user_data_rls.sql`
3. `001c_user_data_verify.sql`

前两段均以 `BEGIN` 开始、`COMMIT` 结束；任意语句报错时不要继续下一段，先执行 `ROLLBACK;` 并保留完整错误信息。

第三段的冒烟数据固定以 `migration_probe_user` 为用户ID，并在同一事务末尾回滚，不应污染正式库。

## 应用运行要求

应用连接账号使用 `diet_app`，每次业务事务必须先绑定用户：

```sql
BEGIN;
SET LOCAL app.user_id = '经过后端认证的用户ID';
-- 该用户本次业务读写
COMMIT;
```

`app.user_id` 只能由可信后端根据已认证身份设置，禁止直接采用客户端提交的任意 userId。

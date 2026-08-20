# PostgreSQL 用户数据结构审核说明

状态：**仅供审核，尚未执行到腾讯云数据库。**

契约来源：`backend/src/domain/userDataContract.js`，`schemaVersion = 1`。

## 字段映射

数据库统一使用 `snake_case`，JavaScript 领域对象继续使用现有 `camelCase`。转换只能放在 `PostgresUserStore`，LangGraph 和 `userDataService` 不直接接触数据库列名。

| JavaScript 契约 | PostgreSQL 列 |
|---|---|
| `body.equationSex` | `app.user_profiles.equation_sex` |
| `body.ageYears` | `age_years` |
| `body.heightCm` | `height_cm` |
| `body.currentWeightKg` | `current_weight_kg` |
| `body.targetWeightKg` | `target_weight_kg` |
| `body.dailyActivity` | `daily_activity` |
| `body.recentWeightChange` | `recent_weight_change` |
| `diet.scene` | `scene` |
| `diet.cafeteriaMode` | `cafeteria_mode` |
| `diet.budgetCnyPerMeal` | `budget_cny_per_meal` |
| `diet.tastePreferences` | `taste_preferences` |
| `diet.restrictions` | `restrictions` |
| `diet.goals` | `goals` |
| `diet.exerciseBaseline` | `exercise_baseline` |
| `menstrualTracking.applicability` | `app.user_menstrual_profiles.applicability` |
| `menstrualTracking.status` | `app.user_menstrual_profiles.status` |
| `eventId` | `app.user_events.event_id` |
| `eventType` | `event_type` |
| `occurredAt` | `occurred_at` |
| `recordedAt` | `recorded_at` |
| `idempotencyKey` | `idempotency_key` |
| `supersedesEventId` | `supersedes_event_id` |

`currentWeightKg` 是档案当前值；单次称重仍写入 `body_measurement.payload.weightKg`，二者不能混用。

## RLS 与敏感数据策略

1. `diet_app` 每次业务事务必须先执行 `SELECT set_config('app.user_id', $1, true)`，且 `$1` 必须先通过 `UserIdSchema`。
2. 普通档案、历史版本、事件和授权均按 `user_id = app.current_user_id()` 隔离。
3. 授权表只允许 `SELECT/INSERT`，没有 `UPDATE/DELETE`，因此撤回通过追加 `revoked` 记录完成。
4. 经期当前档案、经期历史版本和两类经期事件还必须满足：最新 `menstrual_tracking` 授权为 `granted`。
5. 撤回或拒绝后：历史数据不删除，但 `diet_app` 无法读取或写入，也就不会进入长期上下文、模型输入或新方案。
6. 用户重新授权后：旧数据重新可见，符合已确认的“允许恢复历史数据”规则。
7. `diet_owner` 是可信的 `NOLOGIN` 对象所有者，数据库管理员可用于迁移；它不应被应用连接使用。PostgreSQL 表所有者默认可绕过 RLS，因此生产应用凭据只能使用 `diet_app`。

## 执行前还需确认的实现影响

- 当前快照如果把整个 `UserProfileSchema` 原样写进 `profile_revisions`，会包含 `menstrualTracking`。本设计要求 `PostgresUserStore` 将它拆到 `menstrual_profile_revisions`；否则数据库会拒绝普通快照。
- `UserDataService` 已有经期事件授权检查；数据库 RLS 是第二道防线，不能删除服务层检查。
- `occurredAt` 的“必须带时区偏移”由 Zod 在服务层验证；PostgreSQL 使用 `timestamptz` 保存统一时间点。
- 当前契约只规定事件 `payload` 是对象，没有为每种事件定义具体字段。数据库暂不擅自收紧 `meal`、`exercise` 等 payload；应在新增事件 payload 契约后另做迁移。
- 目标时间线、预计达标日期等内部计算字段没有出现在这些用户表或前端 DTO 中；后续若新增内部计划表，必须单独放在不可进入模型/前端输出的数据结构中。

## 审核结论

脚本覆盖契约中的字段范围、枚举、长度、数组数量、事件幂等、纠错引用、50KB payload 限制与授权追加规则。审核通过后才执行；执行后还要分别以 `diet_app` 验证跨用户隔离、经期撤回隐藏、重新授权恢复及事务故障回滚。

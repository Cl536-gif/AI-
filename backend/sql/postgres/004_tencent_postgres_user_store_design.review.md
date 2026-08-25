# 004 腾讯云 PostgreSQL UserStore 接入方案（审核稿）

> 状态：004l已完成本人数据快照云端验收。后续契约复审将跨用户`listUserSummaries`拆出生产UserStore，并为两个合并读取显式加入当前目标账号。生产契约现为37方法，尚未切换业务流量。

## 1. 目标

在003连接池、事务边界和真实云端隔离验收通过的基础上，实现独立的 `TencentPostgresUserStore`，最终替代当前 SQLite UserStore。切换前必须逐项覆盖生产UserStore的37方法契约，并保持数据库RLS、RPC原子性和敏感授权边界；管理型跨用户端口单独管理。

004不复用旧的 `SupabaseUserStore` 统一分发RPC草稿。腾讯云适配器直接使用003的 `withUserTransaction()`，只调用细粒度参数化SQL和已部署的细粒度RPC。

## 2. 当前能力盘点

### 2.1 已实现并完成真实云端验证（20项）

| UserStore方法 | 数据库路径 |
|---|---|
| `ensureUser` | `app.users`，用户事务内幂等插入 |
| `resolveAnonymousIdentity` | `app.resolve_anonymous_identity` |
| `mergeAnonymousIntoAccount` | `app.merge_current_account_from_anonymous` |
| `releaseMergedSensitiveEvents` | `app.release_current_merged_sensitive_events` |
| `getProfile` | 普通/经期当前档案分表读取，并从统一版本头取得 `profileVersion` |
| `updateProfile` | `app.save_current_user_profile_versioned` 原子校验 `expectedVersion` 并写入统一版本账本 |
| `listProfileRevisions` | 统一版本历史引用普通/经期修订，按授权重建领域快照 |
| `appendEvent` | `app.append_current_user_event` |
| `getEvent` | `app.user_events` 参数化读取 |
| `listEvents` | `app.user_events` 参数化读取、限制条数 |
| `recordConsent` | `app.record_current_user_consent` |
| `getLatestConsent` | `app.user_consents` 最新记录读取 |
| `recordActivity` | `app.record_current_user_activity` 原子返回前次活跃时间并写入数据库当前时间 |
| `getUserSettings` | `app.users` 当前用户设置参数化读取 |
| `updateUserTimezone` | `app.update_current_user_timezone` 验证IANA时区并受控更新 |
| `getServiceStatus` | `app.user_service_status` 当前用户服务状态参数化读取 |
| `setServiceStatus` | `app.set_current_user_service_status` 原子替换状态并追加转换历史 |
| `listServiceTransitions` | `app.user_service_transitions` 当前用户转换历史参数化读取 |
| `recordEnergyCalculation` | `app.record_current_user_energy_calculation` 追加不可变计算审计快照 |
| `listEnergyCalculations` | `app.energy_calculations` 当前用户计算历史参数化读取 |

以上方法均已通过代码、假连接测试和真实云端回滚沙箱验证。

### 2.2 仍缺数据库结构或等价语义（16项）

| 能力组 | UserStore方法 | 缺口 |
|---|---|---|
| 方案生命周期 | `createPlanDraft`, `getPlan`, `getActivePlan`, `listPlans`, `transitionPlan`, `activateInitialPlanAndTrial`, `listPlanTransitions` | 方案版本、状态转换及首个计划/试用原子RPC |
| 方案修订命令 | `getPlanRevisionCommand`, `recordPlanRevisionCommand` | 命令幂等表与RLS |
| 提醒 | `enqueueDueRenewalReminders`, `listPendingNotifications`, `markNotificationSent` | 通知表、领取/发送并发语义 |
| 建议历史 | `recordAdvice`, `listAdviceHistory` | 建议历史表、幂等约束与RLS |
| 本人聚合读取 | `getUserDataSnapshot` | 顺序组合已验收的8类本人读取 |
| 管理型跨用户读取 | `listUserSummaries` | 不属于生产UserStore；需单独管理员身份、授权与审计端口 |

### 2.3 身份合并读取契约（已调整）

| UserStore方法 | 原因 |
|---|---|
| `getUserMerge(userId, sourceUserId)` | 显式传入已认证目标账号，PostgreSQL事务以该账号建立RLS上下文，RPC再校验归属 |
| `getMergeReview(userId, mergeId)` | 显式传入已认证目标账号，不根据`mergeId`反查或推断身份 |

不得为了保持旧签名而使用管理员连接绕过RLS。应先把当前账号身份显式加入业务服务和UserStore契约，再调整SQLite实现与测试。

### 2.4 004l聚合读取复审

- `getUserDataSnapshot(userId)`只组合已经验收的本人档案、修订、服务、建议、事件、能量、计划和服务历史，不需要新增表或跨用户权限；适配器按顺序执行8个本人读取，避免测试单连接池耗尽。
- `listUserSummaries({ limit })`属于跨用户管理读取，现有签名没有管理员身份、授权上下文或审计信息；不得给普通`diet_app`增加全局汇总函数。
- 因此生产能力清单调整为：37项`database_ready`、0项`schema_required`、0项`contract_change_required`。
- `listUserSummaries`移出生产UserStore端口，放入独立的管理方法清单；当前仅非生产SQLite调试路由使用，TencentPostgres适配器不实现该跨用户查询。

## 3. 分批顺序

### 004a：冻结能力清单与切换门槛

- 37个生产方法必须全部分类；1个管理方法单独列表，不允许新增方法后静默遗漏。
- `isTencentPostgresCutoverReady()` 必须保持 `false`。
- `USER_STORE_ADAPTER` 继续为 `sqlite`。

### 004b：实现核心用户数据适配器

- 实现当时第2.1节的12项；004d和004e各增加3项，004f增加2项，当前共20项。
- 未实现方法必须抛出固定错误码 `POSTGRES_USER_STORE_METHOD_UNAVAILABLE`，不得返回空成功结果。
- 使用假连接验证SQL参数、用户上下文、返回值映射和事务回滚。
- 不接入 `userStoreProvider` 的生产选择分支。

### 004c：补齐运行必需结构

- 先按依赖顺序迁移活跃/设置、服务状态、建议历史、能量计算与方案生命周期。
- 每组迁移包含：表、约束、索引、RLS、最小权限、原子RPC和回滚验证。
- 通知领取必须设计并发锁定，不能用“先查询再更新”的非原子流程。

### 004d：完整生产37方法契约与云端验证

- SQLite与PostgreSQL对同一契约场景返回等价领域对象。
- 两用户隔离、经期撤回/恢复、幂等、乐观并发、故障回滚和连接耗尽全部通过。
- 云端测试使用独立沙箱用户并证明清理为0。

### 004e：灰度切换

- 先修复所有未 `await` 的业务层调用，确保异步适配器不会泄漏Promise。
- 启动时执行能力门槛检查；不完整则失败关闭。
- 首次只在单实例、可回滚环境设置 `USER_STORE_ADAPTER=tencent-postgres`。
- 保留SQLite只读回退窗口，不做运行中双写。

## 4. 强制安全规则

1. 所有已知用户身份的查询只能在 `withUserTransaction(userId, callback)` 内执行。匿名身份首次解析是唯一引导例外：使用 `withPostgresClient()` 调用不接受原始设备ID、只接受SHA-256摘要的 `app.resolve_anonymous_identity` RPC。
2. 适配器不得调用 `pool.query()`，不得自行执行 `BEGIN`、`COMMIT`、`ROLLBACK` 或 `set_config()`。
3. SQL值全部参数化；动态排序、列名或表名必须来自代码内固定白名单。
4. 多表不变量优先由数据库RPC原子实现；Node.js外层事务只负责组合已经受控的操作。
5. 普通档案和经期档案继续分离；撤回授权后敏感读取必须为空或被拒绝。
6. 错误日志只记录白名单错误码和事件名，不记录数据库消息、SQL、参数或连接配置。
7. 不允许用“空数组”“null”模拟尚未实现的方法成功。

## 5. 切换准入条件

以下条件全部满足前，`USER_STORE_ADAPTER` 必须保持 `sqlite`：

- 37/37生产方法均具备实现且所需云端证据已验证。
- 本地契约、数据库迁移、真实云端和LangGraph端到端回归全部通过。
- 业务层异步调用审计完成。
- 故障回滚、并发和数据清理证据已归档。
- CloudBase环境仍只使用 `diet_app` 私网凭据。

## 6. 004a 验收命令

```sh
cd backend
node manual-test-tencent-postgres-user-store-capabilities.js
```

预期输出包含：

```json
{"batch":"004a","status":"PASS","contractMethodCount":38,"databaseReadyMethodCount":20,"schemaRequiredMethodCount":16,"contractChangeRequiredMethodCount":2,"cutoverReady":false}
```

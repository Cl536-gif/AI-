# 004 腾讯云 PostgreSQL UserStore 接入方案（审核稿）

> 状态：004a 能力盘点已实现；尚未新增适配器、尚未修改数据库、尚未切换业务流量。

## 1. 目标

在003连接池、事务边界和真实云端隔离验收通过的基础上，实现独立的 `TencentPostgresUserStore`，最终替代当前 SQLite UserStore。切换前必须逐项覆盖现有38方法契约，并保持数据库RLS、RPC原子性和敏感授权边界。

004不复用旧的 `SupabaseUserStore` 统一分发RPC草稿。腾讯云适配器直接使用003的 `withUserTransaction()`，只调用细粒度参数化SQL和已部署的细粒度RPC。

## 2. 当前能力盘点

### 2.1 数据库基础已经具备（9项）

| UserStore方法 | 数据库路径 |
|---|---|
| `ensureUser` | `app.users`，用户事务内幂等插入 |
| `resolveAnonymousIdentity` | `app.resolve_anonymous_identity` |
| `mergeAnonymousIntoAccount` | `app.merge_current_account_from_anonymous` |
| `releaseMergedSensitiveEvents` | `app.release_current_merged_sensitive_events` |
| `appendEvent` | `app.append_current_user_event` |
| `getEvent` | `app.user_events` 参数化读取 |
| `listEvents` | `app.user_events` 参数化读取、限制条数 |
| `recordConsent` | `app.record_current_user_consent` |
| `getLatestConsent` | `app.user_consents` 最新记录读取 |

“数据库基础已经具备”不等于适配器实现或云端契约已经通过。实现状态只能在代码、假连接测试和真实云端验证依次通过后升级为 `implemented_and_verified`。

### 2.2 仍缺数据库结构或等价语义（27项）

| 能力组 | UserStore方法 | 缺口 |
|---|---|---|
| 活跃与设置 | `recordActivity`, `getUserSettings`, `updateUserTimezone` | `last_active_at`、`timezone`、`locale` 及受控更新路径 |
| 档案版本 | `getProfile`, `updateProfile`, `listProfileRevisions` | 稳定的 `profileVersion`、`expectedVersion` 原子冲突检查与 `changedFields` 历史语义；现有保存RPC本身不足以满足接口契约 |
| 服务状态 | `getServiceStatus`, `setServiceStatus`, `listServiceTransitions` | 服务状态与转换表、原子RPC |
| 能量计算 | `recordEnergyCalculation`, `listEnergyCalculations` | 计算快照表与RLS |
| 方案生命周期 | `createPlanDraft`, `getPlan`, `getActivePlan`, `listPlans`, `transitionPlan`, `activateInitialPlanAndTrial`, `listPlanTransitions` | 方案版本、状态转换及首个计划/试用原子RPC |
| 方案修订命令 | `getPlanRevisionCommand`, `recordPlanRevisionCommand` | 命令幂等表与RLS |
| 提醒 | `enqueueDueRenewalReminders`, `listPendingNotifications`, `markNotificationSent` | 通知表、领取/发送并发语义 |
| 建议历史 | `recordAdvice`, `listAdviceHistory` | 建议历史表、幂等约束与RLS |
| 聚合读取 | `listUserSummaries`, `getUserDataSnapshot` | 依赖上述表完成；管理型跨用户读取还需单独角色边界 |

### 2.3 需要先修改接口契约（2项）

| UserStore方法 | 原因 |
|---|---|
| `getUserMerge(sourceUserId)` | 数据库RPC按“当前目标账号”授权，但接口没有目标账号/当前账号参数，适配器无法建立正确RLS上下文 |
| `getMergeReview(mergeId)` | 数据库RPC同样要求当前目标账号，接口只有 `mergeId`，不能安全推断用户身份 |

不得为了保持旧签名而使用管理员连接绕过RLS。应先把当前账号身份显式加入业务服务和UserStore契约，再调整SQLite实现与测试。

## 3. 分批顺序

### 004a：冻结能力清单与切换门槛

- 38个方法必须全部分类，不允许新增方法后静默遗漏。
- `isTencentPostgresCutoverReady()` 必须保持 `false`。
- `USER_STORE_ADAPTER` 继续为 `sqlite`。

### 004b：实现核心用户数据适配器

- 实现第2.1节9项。
- 未实现方法必须抛出固定错误码 `POSTGRES_USER_STORE_METHOD_UNAVAILABLE`，不得返回空成功结果。
- 使用假连接验证SQL参数、用户上下文、返回值映射和事务回滚。
- 不接入 `userStoreProvider` 的生产选择分支。

### 004c：补齐运行必需结构

- 先按依赖顺序迁移活跃/设置、服务状态、建议历史、能量计算与方案生命周期。
- 每组迁移包含：表、约束、索引、RLS、最小权限、原子RPC和回滚验证。
- 通知领取必须设计并发锁定，不能用“先查询再更新”的非原子流程。

### 004d：完整38方法契约与云端验证

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

- 38/38方法标记为 `implemented_and_verified`。
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
{"batch":"004a","status":"PASS","contractMethodCount":38,"databaseReadyMethodCount":9,"schemaRequiredMethodCount":27,"contractChangeRequiredMethodCount":2,"cutoverReady":false}
```

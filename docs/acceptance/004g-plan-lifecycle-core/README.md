# 004g PostgreSQL 计划生命周期核心云端验收

验收日期：2026-08-24（Asia/Shanghai）

## 结论

004g 计划版本、状态转换历史和两个受控RPC已在腾讯云 PostgreSQL `diet_secretary` 完成部署，并在 CloudBase 版本018通过真实私网数据库回滚沙箱验收。

- 部署前只读检查：`PASS`
- 正式迁移工单：执行成功
- 部署后对象、约束、RLS与权限检查：`PASS`
- DMC功能回滚沙箱：全部 `PASS`，清理 `PASS`
- CloudBase版本018真实PostgreSQL适配器验证：10/10项 `PASS`
- 最终清理：`PASS`
- 线上业务存储适配器：仍为 `sqlite`

## 已验证能力

1. `createPlanDraft` 在用户行锁下分配连续版本号，并原子写入初始状态历史。
2. `getPlan`、`getActivePlan` 和 `listPlans` 正确映射JSON与UTC时间，并按版本倒序读取。
3. `transitionPlan` 严格执行 `draft → active → paused/superseded/completed` 状态机。
4. 激活新版时，既有active计划或paused父计划会被原子标记为superseded。
5. 数据库部分唯一索引保证每位用户最多一个active计划。
6. 计划对能量计算和父计划使用同用户复合外键，阻止跨用户引用。
7. 重复active转换及计划内外计算记录不一致以SQLSTATE `22023` 拒绝，且不产生写入。
8. 用户B无法读取用户A的计划或转换历史。
9. `diet_app` 只能读取自己的计划数据；所有写入必须经过SECURITY DEFINER RPC。
10. DMC和CloudBase沙箱事务回滚后，用户、服务状态、计算、计划及历史残留均为0。

## 能力清单

- UserStore契约方法：38
- PostgreSQL数据库已就绪：26
- 仍需数据库结构：10
- 仍需契约调整：2
- PostgreSQL生产切换条件：尚未满足
- `activateInitialPlanAndTrial`：保留至004h，以单一事务同时激活首个计划和14天体验。

## 安全说明

首次CloudBase验证未携带显式确认变量，安全护栏按设计返回 `VERIFY_CONFIRMATION_REQUIRED`，没有开始数据库沙箱。随后使用审核过的确认变量运行，10项验证及清理全部通过。

通用OrcaTerm连接的是Ubuntu云服务器而非CloudBase容器，因此未在该环境执行验证。最终验证在部署018的实例Webshell `/app` 中完成。

## 数据边界

- 证据只保存布尔结果、计数、白名单错误码和沙箱汇总。
- 不保存真实用户ID、计划内容、身体数据、密码、数据库地址或连接串。
- DMC与CloudBase功能验证均使用回滚沙箱。
- 本批未修改 `USER_STORE_ADAPTER`；CloudBase版本018验证时线上业务存储仍为SQLite。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

# 广州 PostgreSQL 只读盘点（待云端原始结果）

## 状态

- 盘点范围已按 001–003 仓库结构核对。
- 两份查询均为纯 `SELECT`，不创建临时表，不开启事务，不执行 DDL/DML。
- 查询不返回档案 JSON、事件 payload、确认值、展示值或外部身份哈希。
- 当前 Codex 任务无法接管已登录的 DMC 标签页，本机也没有 `TENCENT_PG_*` 只读连接配置，因此尚未取得广州云库的实时原始结果。

## 执行文件

1. `guangzhou_pg_readonly_inventory_objects_2026-08-19.sql`
   - 环境、容量、扩展、角色与成员关系
   - app schema、表与大小、序列、函数签名及定义哈希
   - RLS 策略、表授权、函数授权
2. `guangzhou_pg_readonly_inventory_data_2026-08-19.sql`
   - 13 张业务表精确行数
   - 只含标识符、状态、时间戳的元数据清单
   - 已知 001–002 验收标识的残留检查

## 已从仓库确认的数据分类规则

### 已知验收测试数据

- 001：`migration_probe_user`（测试脚本预期回滚）
- 002 行为验证：`acct:merge_test_%`、`acct:merge_other_%`、
  `acct:merge_noeligible_%`、`acct:merge_collision_%`、
  `acct:merge_correction_collision_%`、`acct:merge_failure_%`（整批预期回滚）
- 002 双会话并发验证：
  - `anon:fkshare_20260818_190000_k7m2`
  - `acct:fkshare_20260818_190000_k7m2`
  - `fkshare_source_20260818_190000_k7m2`
  - merge `f4e8e10e-8e8d-4f36-a286-2277dfaf860f`
- 002 清理曾返回 `CLEANUP_PASS,0,0,0`；实时盘点将再次验证是否为零。
- 003 验证设计使用回滚，不应产生业务持久数据；003 尚未完成真实云端连接验证。

### 未确认数据

任何不匹配上述标识的行均标记为 `UNCONFIRMED_REVIEW_REQUIRED`，在人工确认前不擅自判定为正式数据或测试数据，更不会删除。

### 必须留档的验收证据

002 双会话 PID、等待顺序和时间戳属于库外操作证据，已写入：

- `002_cloud_deployment_acceptance_2026-08-19.md`

其中包括 Session A PID `24591`、Session B PID `70163`、锁获取/释放及合并返回时间。清理测试数据不会等同于删除该验收文档。最终报告会在云端盘点后确认数据库内是否另有审计行需要保留。


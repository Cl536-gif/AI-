# 002 身份合并真实云端验收

## 最终状态

通过。002a–002d 部署、结构检查、行为验证和双会话并发验证全部完成；测试数据最终清理为零残留。

## 分阶段证据

### 002a 表结构

- 事务提交成功。
- `user_consents.created_at` 已兼容补列。
- 002 新增表存在。
- 预期索引：`found=9`。

### 002b 触发器、RLS 与权限

- 事务提交成功。
- 显式清理 001 旧策略名，避免 permissive 策略“或”组合绕过新限制。
- `NO FORCE ROW LEVEL SECURITY` 状态显式设置。
- `enforce_active_user_write` 使用 `FOR KEY SHARE`。

### 002c RPC

- SQL 变更工单执行完成。
- 10 个关键 RPC/辅助函数的 owner、SECURITY DEFINER 和执行权限核验通过。
- 一次性确认请求链完成：提出值、单次凭证、值匹配消费、状态单向流转。

### 002d 完整验证

- 结构检查：`75,75,0,none`。
- 行为检查：PASS，运行 ID `c49696cd-708c-44c2-bf86-e609b6115bda`。
- 临时验证表清理成功。

## `FOR KEY SHARE` 双会话并发证据

| 事件 | PID | 时间（+08:00） |
|---|---:|---|
| 会话 A 获取锁 | 24591 | 2026-08-19 10:08:33.343125 |
| 会话 B 发起合并 | 70163 | 2026-08-19 10:09:48.166436 |
| 会话 A 释放锁 | 24591 | 2026-08-19 10:13:45.332692 |
| 合并事务写入 `mergedAt` | — | 2026-08-19 10:13:45.335488 |
| 会话 B 返回 | 70163 | 2026-08-19 10:13:45.344079 |

会话 B 等待约 237.178 秒，并在会话 A 释放锁后才完成，证明 `FOR KEY SHARE` 的真实阻塞顺序成立，而非单会话模拟。

## 合并结果

- Merge ID：`f4e8e10e-8e8d-4f36-a286-2277dfaf860f`
- Source：`anon:fkshare_20260818_190000_k7m2`
- Target：`acct:fkshare_20260818_190000_k7m2`
- Status：`completed` / 数据库记录 `merged`
- Migrated events：1
- Profile conflicts：0
- Deduplicated events：0
- Idempotent replay：false

## 负向与清理检查

- 权限与状态拒绝：`42501`、`P0001`、`P0001`、`42501` 均按预期出现。
- 首次清理因 `user_events_user_id_fkey` 阻止删除父用户而失败；事务进入 aborted 状态。
- 调整清理顺序并重新执行后，最终输出：`CLEANUP_PASS,0,0,0`。
- 2026-08-20 只读盘点再次确认 13 张 `app` 业务表全空。

## 截图索引

截图文件与证明内容见根目录 `evidence-index.csv`。截图只作为当时界面原始证据；文字输出中的 PID、精确时间和合并 JSON 仍以 `raw-results.txt` 为准。


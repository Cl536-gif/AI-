# 腾讯云 PostgreSQL 用户数据基线验收记录

- 验收日期：2026-08-18
- 目标数据库：`diet_secretary`
- 执行界面：腾讯云 DMC
- 范围：第一批用户身份、普通档案、经期档案、历史快照、授权和用户事件
- 结论：本批数据库基线验收通过

## 结构与安全总审计

最终只读审计共 18 项，全部返回 `PASS`：

- 7 张 `app` 核心表存在，所有者均为 `diet_owner`。
- 7 张表全部开启 RLS，策略数量达到预期基线。
- `app.current_user_id()` 和 `app.current_user_has_consent(varchar)` 存在。
- `vector` 扩展版本为 `0.8.2`。
- `pgcrypto` 扩展版本为 `1.3`。
- `diet_app` 可连接数据库并使用 `app` schema，但不能在 `app` schema 中创建对象。
- 四个 RPC 的所有者均为 `diet_owner`，`diet_app` 可执行，`PUBLIC` 不可执行。

RPC 安全属性：

| RPC | SECURITY DEFINER |
| --- | --- |
| `app.save_current_user_profile(jsonb, varchar)` | `true` |
| `app.save_current_user_menstrual_profile(jsonb, varchar)` | `true` |
| `app.record_current_user_consent(jsonb)` | `true` |
| `app.append_current_user_event(jsonb)` | `false` |

## 真实云端行为验证

### 普通档案 RPC

- 当前档案与历史快照在同一 RPC 中成功保存。
- 故障注入时当前档案与历史快照一起回滚，没有留下半条数据。

### 经期档案 RPC

- 有效授权后可保存当前档案与历史快照。
- 撤回授权后当前用户不可读取、不可继续写入，物理历史仍保留。
- 重新授权后历史恢复可见，可继续更新。
- 故障注入回滚测试通过。

### 用户事件 RPC

以下五组测试全部返回 `PASS`：

1. 普通餐食事件正常写入。
2. 同一 `idempotencyKey` 连续提交两次：两次返回相同 `eventId`，数据库只有一行，并保留第一次的 payload。
3. 纠错事件以追加方式保留原事件；引用其他用户事件被复合外键拒绝，SQLSTATE 为 `23503`。
4. 经期事件未授权时拒绝写入，授权后可写入，撤回后不可见且不可继续写入；两次拒绝的 SQLSTATE 均为 `42501`。
5. 故意制造 `event_id` 唯一约束冲突，SQLSTATE 为 `23505`；原事件保持不变，失败请求残留行数为 0。

## 运行时缺陷与修复

事件 RPC 首次真实写入时暴露错误：

```text
null character not permitted
```

根因是 advisory lock 键使用了 `v_user_id || chr(0) || v_idempotency_key`。PostgreSQL `text` 不允许包含空字符。

修复后改为先将用户 ID 和幂等键编码为 JSON 数组，再计算哈希：

```sql
hashtextextended(
  jsonb_build_array(v_user_id, v_idempotency_key)::text,
  0
)
```

修正版重新部署后，普通写入、幂等重试及后续全部行为测试均通过。

## 本基线未覆盖的工作

- 游客身份与正式身份合并的云端原子 RPC。
- 本地后端通过 PostgreSQL 连接池接入腾讯云。
- `UserStore` 在腾讯云上的完整契约测试。
- LangGraph 真实云端读写与端到端回归。
- 提醒、订阅、方案生命周期和 RAG 向量表的后续批次。

## 证据边界

- 所有行为测试都在 DMC 事务中运行，末尾使用 `ROLLBACK`，不保留测试用户或事件。
- 本记录不包含数据库地址、账号、密码或密钥。
- “基线验收通过”仅指本文档列出的第一批用户数据结构与 RPC，不代表完整产品数据层已上线。

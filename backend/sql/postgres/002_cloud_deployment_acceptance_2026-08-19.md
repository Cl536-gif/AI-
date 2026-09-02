# 002 身份合并第二批迁移：腾讯云真实部署验收记录

- 部署环境：腾讯云 PostgreSQL，数据库 `diet_secretary`
- 部署日期：2026-08-18 至 2026-08-19（Asia/Shanghai）
- 结论：002a、002b、002c、002d 均已部署；结构、行为和双会话并发验证全部通过
- 清理结论：专用并发测试用户、事件和合并记录均为 0

## 1. 部署前基线确认

部署前只读检查确认 `app.user_consents` 有以下六列，尚无 `created_at`：

```text
consent_id   uuid                     NOT NULL  gen_random_uuid()
user_id      character varying        NOT NULL
consent_type character varying        NOT NULL
status       character varying        NOT NULL
recorded_at  timestamp with time zone NOT NULL
source       character varying        NOT NULL  'user'::character varying
```

因此 002a 采用“新增 `created_at`、不改动 `recorded_at`”的兼容路径。

## 2. 002a 部署

DMC 最后执行到 `COMMIT`，显示成功。部署后只读核验 10 项全部为 `true`，关键原始结果：

```text
column:user_consents.created_at | true | type=timestamp with time zone, nullable=NO, default=clock_timestamp()
column:user_events.status        | true | type=character varying, nullable=NO, default='active'::character varying
constraint:profile_revisions_user_revision_unique | true | UNIQUE (user_id, revision_id)
indexes:002a_expected_9          | true | found=9
table:event_merge_audit          | true | BASE TABLE
table:long_term_profile_confirmation_requests | true | BASE TABLE
table:long_term_profile_field_confirmations   | true | BASE TABLE
table:profile_merge_conflicts    | true | BASE TABLE
table:user_identities            | true | BASE TABLE
table:user_merges                | true | BASE TABLE
```

## 3. 002b 部署

由于 DMC 临时 SQL 窗口单次字符限制，002b 在同一数据库会话中分两段执行，最终 `COMMIT` 成功。最后一段原始执行信息包含：

```text
CREATE POLICY user_events_insert_own ... | 成功
COMMIT                                   | 成功
```

## 4. 002c 部署

DMC “导入导出”不支持 PostgreSQL，因此改用 SQL 变更工单上传完整 SQL 文件：

```text
工单：ord-81m1oby1
执行：exec-7colnj5p
文件：002c_identity_merge_rpcs.review.sql
文件大小：44.21 KB
开始：2026-08-18 18:33:58
结束：2026-08-18 18:34:07
状态：已完成
```

部署后 10 个函数的存在性、所有者、`SECURITY DEFINER` 和执行授权均与设计一致；`PUBLIC EXECUTE` 全部为 `false`。包含：

```text
app.begin_current_long_term_profile_confirmation(varchar,varchar,jsonb,timestamptz)
app.get_current_merge_review(uuid)
app.get_current_user_merge(varchar)
app.merge_current_account_from_anonymous(varchar)
app.merge_value_is_blank(jsonb)
app.profile_snapshot_for_merge(varchar)
app.release_current_merged_sensitive_events(uuid)
app.resolve_anonymous_identity(varchar,varchar)
app.save_current_long_term_profile_fields(jsonb,jsonb,uuid,varchar,timestamptz)
app.user_event_merge_fingerprint(varchar,timestamptz,jsonb,varchar)
```

## 5. 002d 结构与行为验证

002d 通过 SQL 变更工单执行：

```text
工单：ord-xd2rvtp0
执行：exec-nu3o322b
文件：002d_identity_merge_verify.review.sql
文件大小：58 KB
开始：2026-08-18 18:42:49
结束：2026-08-18 18:42:55
状态：已完成
```

由于工单不保留 `SELECT` 结果集，随后在 DMC SQL 窗口执行同一审核 SQL 的分段传输版本。

结构核验原始汇总：

```csv
"75","75","0","none"
```

含义：预期 75 项、通过 75 项、失败 0 项、失败列表 `none`。

行为核验原始输出：

```csv
"PASS","c49696cd-708c-44c2-bf86-e609b6115bda","true","true","true","true","true","true","true","true","true","true","true","true","true","2","1","2","true","true","0","0","true","true","true","true","true","true","true"
```

该行覆盖确认请求链、身份合并、旧授权隔离、敏感事件重新授权、跨账号不可见、旧游客写入拒绝、幂等语义冲突拒绝、纠错引用冲突拒绝和失败注入整体回滚。

## 6. FOR KEY SHARE 双会话并发验证

测试脚本使用专用固定测试用户：

```text
anon:fkshare_20260818_190000_k7m2
acct:fkshare_20260818_190000_k7m2
```

初始化原始输出：

```csv
"SETUP_PASS","2","{acct:fkshare_20260818_190000_k7m2,anon:fkshare_20260818_190000_k7m2}"
```

两个独立数据库后端：

```text
会话 A backend PID：24591
会话 B backend PID：70163
```

会话 A 在未提交事务中写入游客事件后持锁，原始输出：

```csv
"SESSION_A_LOCK_HELD_DO_NOT_COMMIT",24591,"2026-08-19 10:08:33.343125+08:00"
```

会话 B 于 10:09:48 发起合并后持续处于执行中，直到会话 A 释放锁。会话 A 的原始释放输出：

```csv
"SESSION_A_RELEASING_LOCK",24591,"2026-08-19 10:13:45.332692+08:00"
```

会话 B 解除阻塞后的完整原始输出：

```csv
"SESSION_B_MERGE_RETURNED",70163,"2026-08-19 10:09:48.166436+08:00","2026-08-19 10:13:45.344079+08:00","{""status"": ""completed"", ""mergeId"": ""f4e8e10e-8e8d-4f36-a286-2277dfaf860f"", ""mergedAt"": ""2026-08-19T10:13:45.335488+08:00"", ""sourceUserId"": ""anon:fkshare_20260818_190000_k7m2"", ""targetUserId"": ""acct:fkshare_20260818_190000_k7m2"", ""idempotentReplay"": false, ""migratedEventCount"": 1, ""profileConflictCount"": 0, ""deduplicatedEventCount"": 0}"
```

时间顺序：

```text
B 发起合并     10:09:48.166436
A 释放行锁     10:13:45.332692
数据库合并边界 10:13:45.335488
B 返回结果     10:13:45.344079
```

B 等待约 3 分 57 秒，证明真实发生跨会话锁等待。A 锁前完成的事件被迁移一次。

落库核验原始输出：

```csv
"PASS","f4e8e10e-8e8d-4f36-a286-2277dfaf860f","2026-08-19 10:13:45.335488+08:00","merged","acct:fkshare_20260818_190000_k7m2","active","1","1","1"
```

字段依次证明：源用户为 `merged`、指向目标账号、目标仍为 `active`、源事件保留 1 条、目标迁移事件 1 条、迁移审计 1 条。

旧游客四条写路径反向核验：

```csv
"PASS","true","42501","true","P0001","true","P0001","true","42501"
```

事件和确认请求由权限边界以 `42501` 拒绝；档案和授权由 RPC 主动业务异常 `P0001` 拒绝；四条路径均未写入。

## 7. 清理过程与最终状态

初版清理先删用户，真实云端暴露 `user_events.user_id` 为限制型外键，原始错误：

```text
pq: update or delete on table "users" violates foreign key constraint
"user_events_user_id_fkey" on table "user_events"
[ae3735da-f9ed-4163-8165-a7112ad23350]
```

失败事务随后出现：

```text
pq: current transaction is aborted, commands ignored until end of transaction block
```

DMC 当前执行面板无法将单独 `ROLLBACK` 送出失败状态，因此终止该 SQL 会话，依赖 PostgreSQL 连接关闭自动回滚。清理脚本改为“删合并记录及审计 → 显式删事件 → 删用户”。最终原始输出：

```csv
"CLEANUP_PASS","0","0","0"
```

含义：剩余测试用户 0、测试事件 0、测试合并记录 0。

## 8. DMC 平台限制与权限收尾

本次真实部署确认以下平台边界：

1. 临时 SQL 窗口单次执行文本存在 10,000 字符限制。
2. DMC 导入导出工单不支持 PostgreSQL 实例。
3. PostgreSQL 权限申请界面只能选择“全部库”，无法只选择 `diet_secretary`。
4. 为上传 002c/002d，临时申请了 SQL 窗口和 SQL 变更工单权限。2026-08-19 验收完成后，两项“全部库”权限均已逐项回收；“用户授权管理”最终显示“暂无数据”。已登记的数据源和管控实例继续保留。

## 9. 验收结论

002 身份合并第二批迁移已完成真实云端验收：

- 002a 表结构与兼容补列通过。
- 002b RLS、触发器、并发写总闸门通过。
- 002c 确认请求链与身份合并 RPC 通过。
- 002d 75/75 结构项及完整行为用例通过。
- `FOR KEY SHARE` 双会话真实阻塞、释放、迁移、审计和反向写拒绝通过。
- 测试数据已全部清理。
- 临时“全部库”SQL 变更工单和 SQL 窗口权限已全部撤销。

002 批次至此正式闭环。下一批按既定顺序进入连接池接入，等待单独开始指令。

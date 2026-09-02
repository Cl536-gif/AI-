# 002 游客身份合并迁移方案（审核稿）

> 状态：仅供设计审核，尚未生成可部署 SQL，尚未修改腾讯云数据库。
>
> 前置基线：`001` 用户数据基线已于 2026-08-18 通过 18 项真实云端验收。

## 1. 目标

在一个 PostgreSQL 事务中，将经后端认证的游客身份 `anon:*` 合并到当前已登录账号 `acct:*`，并保证：

- 正式账号档案优先，游客只填补空缺字段。
- 两边均有值且不同时，不静默覆盖，而是生成冲突审核记录。
- 普通事件迁移到正式账号，重复事件去重但保留审计证据。
- 经期敏感历史不继承游客授权；迁移后保持受限，需要合并后的新授权才能释放。
- 设备身份摘要原子改绑到正式账号，数据库不保存原始 device ID。
- 旧游客身份被锁定，合并后不能继续写入档案、授权或事件。
- 相同游客重复提交到同一账号时幂等返回原合并结果；尝试合并到其他账号时拒绝。

## 2. 本批边界

### 本批包含

1. `app.user_identities`：设备/外部身份摘要到用户的映射。
2. `app.user_merges`：每个游客的唯一合并记录。
3. `app.profile_merge_conflicts`：正式档案与游客档案的字段级冲突。
4. `app.event_merge_audit`：事件迁移、去重和敏感受限的证据。
5. `app.long_term_profile_confirmation_requests`：秘书展示值到用户回应之间的一次性结构化确认请求。
6. `app.long_term_profile_field_confirmations`：长期建档中经用户明确确认、具备合并资格的字段事实。
7. `app.user_events.status`：区分正常事件与合并后待重新授权的敏感事件。
8. 纠错事件在目标侧按映射顺序追加，保留现有同用户复合外键。
9. 合并、查询合并、获取冲突审核、释放敏感历史所需的 RPC 边界。
10. 防止 `merged` 源用户继续写入的数据库级规则。

### 本批不包含

- Node.js PostgreSQL 连接池。
- 38 个 `UserStore` 方法的其余映射。
- 提醒、订阅、方案生命周期、建议历史和 RAG 表。
- 冲突审核的前端管理界面。

## 3. 新增表

### 3.1 `app.user_identities`

| 字段 | 类型 | 约束/含义 |
| --- | --- | --- |
| `identity_type` | `varchar(32)` | 初期允许 `device_sha256`，后续可版本化扩展 |
| `external_subject_hash` | `char(64)` | 只保存 SHA-256 小写十六进制摘要 |
| `user_id` | `varchar(128)` | 外键到 `app.users` |
| `created_at` | `timestamptz` | 首次绑定时间 |
| `last_seen_at` | `timestamptz` | 最后使用时间 |

主键：`(identity_type, external_subject_hash)`。另建 `user_id` 索引。

安全规则：不接受原始 device ID；摘要必须匹配 `^[0-9a-f]{64}$`。`diet_app` 不直接读写此表，只能调用受控 RPC。

### 3.2 `app.user_merges`

| 字段 | 类型 | 约束/含义 |
| --- | --- | --- |
| `merge_id` | `uuid` | 主键，默认 `gen_random_uuid()` |
| `source_user_id` | `varchar(128)` | 唯一，必须为 `anon:*` |
| `target_user_id` | `varchar(128)` | 必须为 `acct:*` |
| `status` | `varchar(20)` | 本批仅允许 `completed` |
| `merged_at` | `timestamptz` | 合并提交时间 |

`source_user_id` 唯一约束是幂等保障之一。失败合并整个事务回滚，不创建 `failed` 半成品记录。

### 3.3 `app.profile_merge_conflicts`

| 字段 | 类型 | 约束/含义 |
| --- | --- | --- |
| `conflict_id` | `uuid` | 主键 |
| `merge_id` | `uuid` | 外键到 `user_merges`，级联删除 |
| `field_path` | `varchar(100)` | 例如 `body.currentWeightKg` |
| `account_value` | `jsonb` | 正式账号值 |
| `guest_value` | `jsonb` | 游客值 |
| `account_updated_at` | `timestamptz` | 可空 |
| `guest_updated_at` | `timestamptz` | 可空 |
| `account_stale_over_30_days` | `boolean` | 账号档案是否超过 30 天未更新 |
| `resolution_status` | `varchar(20)` | `pending/account_kept/guest_accepted` |
| `created_at` | `timestamptz` | 创建时间 |

同一合并中 `field_path` 唯一。本批只生成 `pending`，不实现后台裁决写入。

### 3.4 `app.event_merge_audit`

| 字段 | 类型 | 约束/含义 |
| --- | --- | --- |
| `audit_id` | `uuid` | 主键 |
| `merge_id` | `uuid` | 外键到 `user_merges`，级联删除 |
| `source_event_id` | `varchar(128)` | 游客原事件 ID |
| `target_event_id` | `varchar(128)` | 去重后或迁移后的目标事件 ID |
| `action` | `varchar(32)` | `migrated/deduplicated/migrated_restricted` |
| `event_hash` | `char(64)` | 事件指纹 |
| `created_at` | `timestamptz` | 创建时间 |

同一合并中 `source_event_id` 唯一。指纹的规范输入为：

```text
event_type + occurred_at(UTC ISO-8601) + payload(jsonb canonical text)
+ normalized_supersedes_event_id(user_correction only)
```

幂等键优先于指纹判断重复。

### 3.5 `app.long_term_profile_confirmation_requests`

秘书主动摆出待复核字段时，数据库记录 `onboarding_session_id`、`prompt_turn_id`、`presented_fields` 和提问时间，并生成一次性 `request_id`。同一用户、同一建档会话只允许一个 `pending` 请求；新请求会取消旧请求。

请求只能从 `pending` 进入 `consumed` 或 `cancelled`。`consumed` 必须具有不同于提问轮次的 `response_turn_id`，且回应时间不得早于提问时间。不保存对话原文。

同一 `prompt_turn_id` 是用户级幂等键：完全相同的重试返回原请求；会话、展示字段或提问时间不同则整体拒绝。同一用户、同一建档会话开启不同的新请求时，只取消该会话原有的 `pending` 请求；旧行不删除，以 `cancelled + resolved_at` 留痕，新请求以同一数据库切换时间写入 `created_at`。

### 3.6 `app.long_term_profile_field_confirmations`

该表以追加事实记录游客在长期建档中明确确认的字段，不替代 `user_profiles` 当前快照。

| 字段 | 类型 | 约束/含义 |
| --- | --- | --- |
| `confirmation_id` | `uuid` | 主键 |
| `user_id` | `varchar(128)` | 所属用户 |
| `field_path` | `varchar(100)` | 只允许 14 个普通档案白名单路径 |
| `confirmed_value` | `jsonb` | 本次经用户明确确认的规范值 |
| `profile_revision_id` | `uuid` | 与同一用户的普通档案修订建立复合外键 |
| `onboarding_session_id` | `varchar(128)` | 后端生成的必填审计键，不暴露给模型 |
| `confirmed_at` | `timestamptz` | 业务确认时间 |
| `created_at` | `timestamptz` | 数据库入库时间 |

每条字段确认事实必须关联同用户、同建档会话的已消费确认请求。普通问答不写该表。旧值只有在长期建档中被秘书主动重新摆出、且用户正面回应确认后，才能写入确认事实。后台静默复用旧值不构成确认。

同一字段的最新合格值按数据库 `created_at DESC, confirmation_id DESC` 选取，不用业务时钟决定先后顺序。

## 4. 现有表变更

### 4.1 `app.user_events.status`

新增：

```text
status varchar(32) NOT NULL DEFAULT 'active'
```

允许值：

- `active`：正常可见事件。
- `restricted_pending_consent`：合并迁入的经期敏感历史，等待合并后的新授权。

`status` 是数据库内部状态，不加入客户端 `UserEventSchema` 的可写白名单，`append_current_user_event` 仍只能创建 `active` 事件。

RLS 的事件读取条件改为：

```text
user_id = current_user
AND status = 'active'
AND (非经期事件 OR 当前存在有效经期授权)
```

这样即使正式账号在合并前有过经期授权，新迁入的游客敏感历史也不会自动暴露。

### 4.2 `app.user_consents.created_at` 基线收敛

001历史稿对该列存在差异。002a必须保证 `created_at timestamptz NOT NULL DEFAULT <数据库时间>` 存在：缺失时补列，已存在时严格核对类型、非空和数据库默认值，形态不符则中止迁移。该时间不接受授权RPC调用方传入，用于证明重新授权记录确实在合并后入库。

### 4.3 纠错事件复合外键

现有：

```sql
FOREIGN KEY (user_id, supersedes_event_id)
REFERENCES app.user_events(user_id, event_id)
```

本批保留该外键不变，不再移动游客原事件。合并 RPC 先向目标用户追加原事件副本，再追加纠错事件副本并将 `supersedes_event_id` 指向目标侧映射。因此每次 INSERT 当下就满足同用户外键，无需延迟约束。

### 4.4 合并后源用户禁止写入

仅把 `app.users.status` 改为 `merged` 不足以禁止事件和授权直接写入。本批必须同时：

1. 修正 `append_current_user_event` 与 `record_current_user_consent`，明确检查当前用户状态为 `active`。
2. 收紧 `user_events` 与 `user_consents` 的 INSERT RLS，要求当前 `app.users.status = 'active'`。
3. 保留普通档案和经期档案 RPC 已有的 active 状态检查，并在测试中覆盖所有写入入口。

## 5. 档案合并规则

不合并 `user_menstrual_profiles`，不继承游客 `user_consents`。

合并前先对每个游客字段执行资格过滤：

1. 只查找 `long_term_profile_field_confirmations` 中该字段的最新确认事实。
2. 没有确认事实的字段视为不存在：不填补、不比较、不生成冲突。
3. 不直接信任游客 `user_profiles` 当前行，因为它可能被普通问答值覆盖。
4. 游客从未产生任何长期建档字段确认时，合并不保存目标档案、不追加档案修订、不生成冲突；注册后重新走基础信息采集。

通过资格过滤的普通档案字段再执行“账号优先”：

| 正式账号值 | 游客值 | 结果 |
| --- | --- | --- |
| 空缺 | 有值 | 填入游客值 |
| 有值 | 空缺 | 保留账号值 |
| 相同 | 相同 | 保留，不生成冲突 |
| 有值且不同 | 有值且不同 | 保留账号值，写入 `profile_merge_conflicts` |

空缺定义：

- `NULL`。
- 枚举值 `unknown`。
- JSONB 数组 `[]`。
- 空字符串仅用于兼容旧数据；新数据不应写入空字符串。

长期建档写入必须使 `user_profiles` 更新、`profile_revisions` 追加和字段确认事实追加处于同一数据库事务。客户端不能通过自报 `isLongTermOnboarding` 获得合并资格。

合并时如果至少塥补一个合格字段，使用现有 `save_current_user_profile` RPC 保存目标档案，并从数据库合并后的规范列追加一条 `profile_revisions` 快照。来源固定为 `system`，不接受客户端覆盖。

30 天过期标记只是冲突审核提示，不会自动让游客值覆盖正式值。

## 6. 事件迁移与去重

### 6.1 普通事件

1. 先按 `(target_user_id, idempotency_key)` 查找重复，幂等键为空时跳过。
2. 再按事件指纹查找重复。
3. 重复时不删除游客原行，将其留在已锁定的源用户下，并写入 `deduplicated` 审计。
4. 不重复时向目标用户追加一条新事件，保持原始时间和 payload，但使用新 `event_id`；审计表保存 source/target ID 映射。

所有源事件（包括非重复事件）都保留在已锁定的游客身份下；目标侧使用追加副本。这避免了移动原行时破坏纠错事件的复合外键，同时保留完整原始证据。源用户被标记 `merged` 后不再作为业务身份读写。

### 6.2 纠错事件

合并事务内建立临时映射：

```text
source_event_id -> target_event_id + action
```

先处理非 `user_correction` 事件，再处理纠错事件。纠错事件的 `supersedes_event_id` 必须改写为原事件对应的目标事件 ID：

- 原事件被迁移：目标 ID 为新追加的目标副本 ID。
- 原事件被去重：目标 ID 为已存在的正式账号事件 ID。
- 找不到映射：整个合并失败回滚，不留半合并状态。

### 6.3 敏感事件

`menstrual_period_start` 和 `menstrual_symptom` 迁移时将 `status` 设为 `restricted_pending_consent`，审计 action 为 `migrated_restricted`。新迁移的 `user_correction` 如果直接或间接引用受限事件，也沿引用链保持 `restricted_pending_consent`，避免纠错记录提前暴露敏感历史的存在或内容；合并后重新授权时按同一审计 action 一并释放。

释放前必须满足：

- 合并目标是当前已认证账号。
- 最新 `menstrual_tracking` 授权为 `granted`。
- 该授权的 `recorded_at >= user_merges.merged_at`，且数据库生成的 `created_at >= user_merges.merged_at`。后者不信任客户端时钟，严格证明授权行是在合并后入库。

## 7. RPC 边界

### 7.1 解析游客身份

```text
app.resolve_anonymous_identity(p_identity_type, p_external_subject_hash) -> jsonb
```

- 只接受后端已计算的 SHA-256 摘要。
- 同一摘要幂等返回同一 `anon:*` 用户。
- 已改绑的摘要返回 `acct:*` 目标用户。
- 该 RPC 属于受信后端身份边界，不允许客户端直接调用数据库。

### 7.2 原子保存长期建档字段确认

```text
app.begin_current_long_term_profile_confirmation(
  p_onboarding_session_id,
  p_prompt_turn_id,
  p_presented_fields,
  p_prompted_at
) -> jsonb

app.save_current_long_term_profile_fields(
  p_profile,
  p_confirmed_fields,
  p_confirmation_request_id,
  p_response_turn_id,
  p_responded_at
) -> jsonb
```

- 起始 RPC 只能由秘书实际展示值的路径调用，生成一次性 `pending` 请求。
- 完成 RPC 消费该请求，并在同一事务保存档案、追加档案修订和字段确认事实。
- `confirmed_value` 只从数据库保存后的规范快照中提取，调用方不能另行传入一份不一致的值。
- `onboarding_session_id` 必填，由受信后端生成，不进入模型上下文。
- 同一完成请求、同一回应和同一档案参数可幂等返回原结果；复用请求但改变参数则整体拒绝。
- 完成 RPC 只允许在“秘书主动摆出值，用户正面回应确认”后调用。仅因后台已存在旧值而静默复用，不得产生确认事实。

### 7.3 原子合并

```text
app.merge_current_account_from_anonymous(p_source_user_id varchar) -> jsonb
```

- 只接受源游客 ID，不接受 target user ID。
- 目标账号只从 `app.current_user_id()` 读取，且必须为 `acct:*`。
- 源必须为 `anon:*`、存在、状态为 `active`。
- 使用基于 `source_user_id` 的事务级 advisory lock 防止并发双合并。
- advisory lock 键使用 JSON 数组规范编码后哈希，不使用 `chr(0)`。
- 相同 source/target 重试返回原 `merge_id`；不同 target 拒绝。

### 7.4 合并查询与审核

```text
app.get_current_user_merge(p_source_user_id varchar) -> jsonb/null
app.get_current_merge_review(p_merge_id uuid) -> jsonb
```

只能读取 `target_user_id = app.current_user_id()` 的合并记录，不直接授予 `diet_app` 对底层审计表的 SELECT。

### 7.5 释放合并的敏感历史

```text
app.release_current_merged_sensitive_events(p_merge_id uuid) -> integer
```

只将该合并审计中 `migrated_restricted` 对应、且归属当前账号的事件改为 `active`。必须通过第 6.3 节的合并后新授权检查。

## 8. 原子合并顺序

RPC 内部顺序固定为：

1. 读取当前已认证目标账号，校验 source/target 命名空间。
2. 对 source 获取 advisory transaction lock。
3. 检查已有合并记录，执行幂等返回或冲突拒绝。
4. 锁定 source/target `users` 行及双方档案行。
5. 创建 `user_merges` 记录。
6. 对游客字段先执行长期建档确认资格过滤，再执行账号优先的普通档案合并，写快照和冲突记录。
7. 建立事件映射，先追加/去重非纠错事件。
8. 改写引用后追加/去重纠错事件；原游客事件全部保留不变。
9. 将敏感迁移事件设为受限。
10. 将 `user_identities.user_id` 从 source 改绑为 target。
11. 将 source `users.status` 设为 `merged`，`merged_into_user_id` 设为 target。
12. 确认所有目标事件引用已经在每次插入时通过复合外键；任一步失败则全部回滚。

## 9. 权限与 RLS

- 新表所有者为 `diet_owner`。
- `PUBLIC` 对新表和 RPC 均无权限。
- `diet_app` 不直接获得合并、冲突、事件审计表的读写权限。
- `diet_app` 只获得必要 RPC 的 EXECUTE。
- 跨用户原子合并 RPC 使用 `SECURITY DEFINER`，固定 `search_path = pg_catalog, app`，且所有用户归属检查在函数内明确执行。
- 查询 RPC 也必须校验 target 为当前用户，不以 `SECURITY DEFINER` 作为绕过归属检查的手段。

## 10. 必须通过的真实云端测试

方案B确认请求链必须先通过：

- 没有当前用户的对应 `pending request_id` 时，完成确认被拒绝。
- 确认字段超出本次 `presented_fields` 或保存规范值与展示值不同，整体回滚且请求仍为 `pending`。
- 同一提问轮次同参数重试返回原请求；同轮次不同参数拒绝。
- 同一已消费请求、回应和档案同参数重试返回原修订，不重复写事实；换回应或换参数拒绝。
- 新提问取消同会话旧 `pending` 后，旧行以 `cancelled + resolved_at` 保留，且不能回退、更新或删除确认事实。

1. 未认证或当前用户不是 `acct:*` 时拒绝合并。
2. 非 `anon:*` 源身份被拒绝。
3. 只有普通问答档案、没有长期建档字段确认的游客：零填补、零冲突。
4. 只完成部分长期建档字段的游客：只有已确认字段参与合并。
5. 长期建档确认后又在普通问答中更改当前快照：合并仍使用最新合格确认事实，不使用未确认的新快照值。
6. 账号优先：合格游客字段仅填空缺，冲突不覆盖且进入审核表。
7. 账号档案超过 30 天时冲突只标记，不自动覆盖。
8. 幂等键重复事件去重且写入审计。
9. 无幂等键但指纹相同的事件去重。
10. 普通非重复事件迁移成功。
11. 纠错事件引用被迁移原事件时保持正确。
12. 纠错事件引用被去重原事件时改写到正确目标 ID。
13. 敏感历史迁移后不可见，合并前旧授权不能自动释放。
14. 合并后新授权可精确释放该 merge 的敏感历史。
15. 设备摘要改绑目标账号，原始 device ID 从未入库。
16. 合并后源用户无法写入档案、授权、普通事件或经期事件。
17. 同一 source/target 重试返回同一 `merge_id`。
18. 同一 source 尝试合并到其他 target 被拒绝。
19. 在档案合并和事件迁移已发生、身份改绑阶段注入后段故障，确认前述所有变更与合并记录一起整体回滚。
20. 合并表和审计表不可被其他用户或 `PUBLIC` 读取。

## 11. 已知但未完成的冲突裁决闭环

`profile_merge_conflicts` 在本批只生成 `pending` 记录，这是刻意的分批取舍，不代表冲突已被处理。

已知功能缺口：

- 尚未决定由用户在会话/设置中自主确认，还是由内部后台审核。
- 尚未实现 `pending -> account_kept/guest_accepted` 的受控裁决 RPC。
- 尚未实现待处理数量监控、积压告警、处理时限或审计人记录。

在第一条真实合并上线前，至少必须完成一项运营保障：可查询 `pending` 总数与最早创建时间，避免冲突无声积累。完整裁决交互可作为后续独立批次，但不得将长期 `pending` 误报为已完成。

## 12. 建议审核结论

建议按本方案进入 SQL 审核稿阶段，并固定以下决策：

1. **账号优先**：冲突只记录，不自动覆盖。
2. **敏感授权不继承**：必须使用合并后新授权释放游客经期历史。
3. **重复源事件不删除**：保留在已锁定源身份下，以审计记录指向目标事件。
4. **不信任客户端 target ID**：合并目标只来自后端已认证会话写入的数据库上下文。
5. **不跳过真实云端故障测试**：静态 SQL 审核通过后仍必须逐项运行第 10 节的测试。

审核通过后，下一步才是把本设计拆成：

- `002a_identity_merge_schema.review.sql`
- `002b_identity_merge_rls.review.sql`
- `002c_identity_merge_rpcs.review.sql`
- `002d_identity_merge_verify.review.sql`

四份脚本依次静态审核，不在本设计审核阶段直接部署。

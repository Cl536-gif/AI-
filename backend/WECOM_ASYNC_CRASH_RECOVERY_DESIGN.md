# 企业微信异步处理与崩溃恢复设计（方案 B）

## 状态

- 方案：B——检查持久化状态后决定恢复、补写或重新处理，禁止无脑重跑。
- 当前阶段：设计已确认，尚未开始代码实现。
- 渠道开关：`WECOM_CHANNEL_ENABLED=false`，实现和测试完成前不得开启。

## 设计目标

企业微信消息进入异步处理后，即使 LangGraph 运行期间服务器重启或进程崩溃，也不能让消息永久丢失。服务恢复后必须根据 PostgreSQL 任务记录与 LangGraph checkpointer 中的确定性标记，判断应当：

1. 从头处理一次；
2. 从 checkpoint 继续执行；
3. 只补做业务持久化；
4. 只重建主动回复 Outbox；
5. 继续发送已有 Outbox；
6. 因状态冲突停止自动处理并进入死信。

任何判断都不能只依赖 `processing` 状态、时间戳、尝试次数或消息文本相同。

## 一、每条消息的固定标识

企业微信消息第一次入队时生成并永久固定以下字段：

| 字段 | 说明 |
| --- | --- |
| `request_id` | 内部 UUID 请求 ID |
| `message_key` | 企业微信 `MsgId`；没有 `MsgId` 的事件使用确定性摘要 |
| `input_sha256` | 解密后消息内容的 SHA-256 摘要 |
| `graph_operation_id` | 本轮 LangGraph 持久化操作使用的固定 UUID |
| `thread_id` | `wecom:<成员身份摘要>` |

数据库约束：

```sql
UNIQUE (message_key)
UNIQUE (graph_operation_id)
```

同一个企业微信重试回调只能命中原任务，不能生成新的 `request_id` 或 `graph_operation_id`。

`wecom_inbound_jobs` 主要字段：

```text
request_id
message_key
input_sha256
graph_operation_id
thread_id_hash
status
attempt_count
locked_by
locked_until
last_error_code
created_at
processed_at
```

注意：

> `status='processing'` 本身不能证明消息已经处理过。是否处理完成必须检查 LangGraph 的持久化状态。

## 二、写入 LangGraph 的确定性标记

调用共享 LangGraph 服务时写入：

```js
externalTurnRequest: {
  channel: 'wecom',
  requestId,
  inputSha256,
  operationId: graphOperationId
}
```

本轮用户消息使用确定性消息 ID：

```text
message.id = wecom:<request_id>
```

现有状态中的持久化字段继续使用，但 `operationId` 必须取自任务表中固定的 `graph_operation_id`，重试时不得重新生成：

```js
persistenceRequest: {
  operationId: graphOperationId
}

persistenceReceipt: {
  operationId: graphOperationId
}
```

处理完成后写入：

```js
externalTurnReceipt: {
  requestId,
  inputSha256,
  operationId: graphOperationId,
  replySha256,
  completedAt
}
```

“消息已经处理过，只是任务表状态没有成功落库”的权威证据是以下四项完全匹配：

```text
externalTurnRequest.requestId   == job.request_id
externalTurnRequest.inputSha256 == job.input_sha256
externalTurnRequest.operationId == job.graph_operation_id
persistenceReceipt.operationId  == job.graph_operation_id
```

这组匹配证明：

- 该请求确实进入过指定 LangGraph 线程；
- 处理的是同一份输入；
- 使用的是同一个持久化操作；
- 图产生的业务副作用已经持久化并确认。

此时即使 `wecom_inbound_jobs.status` 仍然是 `processing`，也不得重新调用模型。

## 三、恢复时的判定顺序

Worker 重新领取租约过期的任务后，必须按以下顺序判断。

### 情况 1：Outbox 或数据库回执已经存在

查询：

```text
wecom_graph_receipts.request_id = job.request_id
或
wecom_outbound_messages.request_id = job.request_id
```

处理：

- 不运行 LangGraph；
- Outbox 未发送时继续主动发送；
- 已发送时直接将入站任务补记为 `completed`。

### 情况 2：LangGraph 已完整处理，但数据库任务状态未更新

检查：

```text
externalTurnRequest 三个字段完全匹配
persistenceReceipt.operationId 完全匹配
```

处理：

- 不重新调用模型；
- 根据确定性用户消息 ID 找到该轮回复；
- 缺少 `externalTurnReceipt` 时重新生成；
- 事务写入 `wecom_graph_receipts` 和 Outbox；
- 将任务更新为 `processed`。

这是“已经处理过，只是状态未落库成功”的核心判断。

### 情况 3：图已生成结果，但业务持久化未确认

检查：

```text
externalTurnRequest 完全匹配
persistenceRequest.operationId == graph_operation_id
persistenceReceipt.operationId != graph_operation_id
```

处理：

- 不重新运行模型；
- 调用现有 `recoverPendingGraphTurn()`；
- 只补做尚未完成的用户资料、建议等持久化；
- 成功后补写 `persistenceReceipt`、渠道回执和 Outbox。

### 情况 4：LangGraph 运行到一半

检查：

```text
externalTurnRequest 完全匹配
checkpoint snapshot.next 非空
或存在未完成 task
```

处理：

- 不追加第二条用户消息；
- 不从头重新调用完整对话；
- 使用原 `thread_id` 和原 `graph_operation_id` 从 checkpoint 恢复；
- 已完成节点由 checkpointer 跳过或恢复，未完成节点继续执行。

这一行为必须通过实际崩溃恢复测试验证，不能只根据接口设计推测。

### 情况 5：没有该请求的任何持久化痕迹

检查不到匹配的：

```text
externalTurnRequest
persistenceRequest
persistenceReceipt
数据库回执
Outbox
```

说明进程是在第一次 LangGraph checkpoint 成功写入前崩溃。

处理：

- 可以安全地从头执行一次；
- 继续使用原 `request_id` 和原 `graph_operation_id`；
- 不生成新的任务身份。

模型可能在崩溃前收到过网络请求，但由于没有图状态或业务副作用提交，重新请求不会造成业务重复。

### 情况 6：字段发生冲突

冲突示例：

```text
requestId 相同但 inputSha256 不同
operationId 相同但 requestId 不同
message_key 相同但消息摘要不同
checkpointer 当前请求属于另一条未完成消息
```

处理：

- 绝不重新执行；
- 标记为 `state_conflict`；
- 进入人工检查或死信；
- 只输出摘要化告警，不记录明文消息。

## 四、同一线程严格顺序处理

同一企业微信成员的消息必须按 FIFO 处理：

```text
只有该 thread_id 最早的一条未完成任务可以被领取
```

否则旧任务崩溃后，新消息可能先推进同一条 LangGraph 线程，使恢复时最新 checkpoint 已属于另一条消息。

- 不同用户可以并行处理；
- 同一用户不得并行处理；
- 数据库领取条件必须排除“同一线程前面还有未完成任务”的任务。

## 五、租约与服务重启恢复

Worker 领取任务时不删除任务，而是写入租约：

```text
status = processing
locked_by = 当前实例 ID
locked_until = 当前时间 + 租约时间
attempt_count += 1
```

正常运行时 Worker 定期续租。进程崩溃后续租停止，租约到期后，新 Worker 可以重新领取：

```sql
WHERE status = 'queued'
   OR (
     status = 'processing'
     AND locked_until < now()
   )
```

服务优雅关闭顺序：

1. 停止领取新任务；
2. 给当前任务有限的完成时间；
3. 未完成时释放租约；
4. 最后关闭 PostgreSQL 连接池。

## 六、崩溃恢复模拟测试

实现后新增命令：

```bash
npm run test:wecom:crash-recovery
```

测试必须启动真实 Node.js 子进程，并使用：

```js
child.kill('SIGKILL')
```

随后启动第二个 Worker 进程，模拟 Pod 被强制终止和服务恢复。

覆盖场景：

| 崩溃点 | 重启后的预期 |
| --- | --- |
| 入队完成、尚未领取 | 新 Worker 领取并处理一次 |
| 取得租约、尚未进入 LangGraph | 租约过期后从头处理一次 |
| LangGraph 中间 checkpoint 已写入 | 从 checkpoint 恢复，不追加重复用户消息 |
| 图结果已生成、`persistenceReceipt` 尚未写入 | 只恢复持久化，不重新生成回复 |
| `persistenceReceipt` 已写入、任务表尚未更新 | 根据标记重建 Outbox，模型调用次数仍为 1 |
| Outbox 已写入、尚未发送 | 重启后继续发送 |
| 企业微信已接收、发送成功状态尚未落库 | 使用相同请求 JSON 和重复检查抑制重复推送 |

测试断言：

```text
langGraphInvocationCount
humanMessageCount
adviceAppliedCount
outboxCount
acceptedSendCount
finalJobStatus
```

关键断言：

```text
相同 request_id 的用户消息只有 1 条
业务副作用只应用 1 次
Outbox 只有 1 条
最终任务状态为 completed
```

测试使用确定性模型替身，避免真实百炼调用影响结果，但必须经过相同的 Worker、PostgreSQL任务表、LangGraph checkpointer 和恢复代码。

测试钩子通过构造参数注入测试子进程，不增加可由生产环境变量触发的主动崩溃后门。

## 七、正常流程回归测试

实现后新增命令：

```bash
npm run test:wecom:regression
```

覆盖范围：

- GET 回调验证；
- POST 验签与 AES 解密；
- PostgreSQL 提交后快速返回 HTTP 200 空响应；
- 正常 Worker 领取；
- 开场话术、免费或长期选择、注销逻辑；
- LangGraph 共享链路；
- `access_token` 缓存与失效刷新；
- UTF-8 2048 字节安全截断；
- 主动发送；
- 重复 `MsgId` 去重；
- 同一成员消息 FIFO；
- 不同成员并行；
- `WECOM_CHANNEL_ENABLED=false` 时无路由、无 Worker、无企业微信网络调用。

## 八、进入虚拟凭证联调的门槛

只有以下两组测试全部通过后，才评估进入虚拟凭证完整联调：

```text
npm run test:wecom:crash-recovery
npm run test:wecom:regression
```

交付时必须提供：

- 两条完整测试命令；
- 完整命令输出；
- 每个崩溃点命中的持久化标记；
- 是否重新调用 LangGraph 的证据；
- 用户消息数、业务副作用数、Outbox数及最终任务状态。

## 核心原则

只认以下四项的一致性：

```text
request_id
input_sha256
graph_operation_id
persistenceReceipt
```

不根据模糊状态无脑重跑。

# 005h LangGraph PostgreSQL 正式 HTTP 双实例灰度验收

验收日期：2026-08-26（Asia/Shanghai）

## 结论

005h 已在独立 CloudBase 临时服务的两个真实 Pod 之间完成正式 `/api/chat-langgraph` 链路的共享 PostgreSQL checkpointer、同 thread 锁、跨实例恢复、并发线性化、幂等重放、精确清理和临时服务下线验证。

- 专用验证服务与正式服务隔离：`PASS`
- 缺失或错误 canary 令牌在身份解析前拒绝：`PASS`
- 身份解析后的受控故障注入：`PASS`
- writer 真实 HTTP 写入及建议持久化：`PASS`
- reader 跨 Pod 恢复既有 checkpoint：`PASS`
- 两个不同实例参与：`PASS`
- contender B 等待同 thread 锁：`11930ms`
- contender 并发重叠：`PASS`
- UserStore 标记幂等重放：`PASS`
- 最终 checkpoint 数：`33`
- checkpoint 父子链分支数：`0`
- 原始身份和公开 thread 标识不落 checkpointer：`PASS`
- DMS 清理前真实 HTTP 建议和双实例标记存在：`PASS`
- 清理建议数：`5`
- 身份、用户、建议清理后残留：`0 / 0 / 0`
- checkpoint、blob、write 全局残留：`0 / 0 / 0`
- 临时验证服务删除：`PASS`
- 正式业务服务未修改，正式全量 PostgreSQL 门禁继续关闭

## 已验证能力

1. 仅专用双实例 HTTP canary 模式可以启用共享 PostgreSQL checkpointer 和同 thread advisory lock；正式 Provider 仍失败关闭。
2. 服务端令牌在匿名身份解析前校验，缺失或错误令牌不会创建测试身份。
3. 受控 `after-identity` 故障返回固定安全错误，随后精确清理可恢复干净起点。
4. writer 通过正式 HTTP 路由创建 checkpoint 并持久化真实建议；reader 在另一 Pod 上读取上一实例状态后继续对话。
5. contender A 在锁内保持期间，contender B 实际等待 11930ms；两次更新形成单一线性 checkpoint 链。
6. UserStore 验证标记重复写入只保留一条，证明幂等键生效。
7. 最终 33 个 checkpoint 的所有父节点存在，每个父节点最多一个子节点，分支数为 0。
8. checkpointer 中不保存固定设备标识、公开 thread、用户 ID 或 run 标识原文。
9. checkpoint 先由应用验证器精确删除，再由 DMS 清理固定身份及全部从属数据；最终三类业务数据与三张 checkpointer 表均为零残留。
10. 临时服务已删除，正式 `diet-secretary-api` 未参与资源清理。

## 失败关闭与诊断证据

1. 临时服务缺少模型环境变量时，真实 HTTP 请求返回非 200，未被计为通过。
2. 模型账户欠费或状态异常时，服务和数据库虽然 ready，真实 HTTP 仍返回 500；账户恢复后同一受控请求才返回 200。该手工诊断轮次已作废并精确清理。
3. checkpoint 不存在时，verify 以 `CP_FINAL_STATE_MISSING` 拒绝把身份存在冒充图状态存在。
4. preflight 在固定测试身份存在时拒绝开始新轮次。
5. 应用角色直接读取受保护身份表被 PostgreSQL 权限策略拒绝；诊断改用安全 RPC 和事务回滚。
6. 所有失败或诊断轮次均在新一轮前完成身份、建议和 checkpoint 零残留确认。

## 发布边界

- 本验收证明正式 LangGraph HTTP 路由在独立、显式确认的双实例 canary 模式下可以共享 checkpoint 并线性化同 thread 请求。
- 本验收不把 `productionReady` 改为 true，不授权全量 PostgreSQL 切换，也不授权绕过实例数、连接池、令牌或故障注入确认门禁。
- `after-identity` 故障不等价于进程在 graph checkpoint 成功后、所有 UserStore 副作用完成前崩溃；该原子性窗口仍需后续阶段处理。
- 未覆盖进程强杀、网络分区、滚动升级、跨区域故障、长期容量、备份恢复或 HMAC 密钥轮换。
- 模型账户可用性是正式 HTTP 链路的外部依赖；余额与账户状态监控仍需补齐。
- 验收档案不保存密钥、连接串、域名、Pod 名称、实例指纹、run ID、进程号、原始身份、thread 值或模型回复正文。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

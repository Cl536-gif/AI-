# 005m LangGraph/UserStore副作用恢复验收

验收日期：2026-08-27（Asia/Shanghai）

## 结论

005m 第一个专项阻断项已完成真实双实例云端闭环：graph checkpoint成功、建议历史已写入后触发受控HTTP 503；另一Pod在相同请求重试时先恢复未完成副作用、写入完成回执，并且没有重复建议或再次推进对话。

- 本地fail-closed守卫：`PASS`
- 故障注入点：建议持久化完成后、回执写入前
- 故障HTTP状态：`503`（受控预期）
- pending request保留：`PASS`
- 跨实例恢复：`PASS`，A/B实例指纹不同
- 完成回执：`PASS`
- 建议仅写入一次：`PASS`
- 相同消息没有再次推进graph：`PASS`
- 原始标识未进入checkpointer：`PASS`
- checkpointer清理：`PASS`，剩余`0`
- DMS精确用户清理：`PASS`，建议证据行`1`，剩余身份/用户/建议均为`0`

## 已验证能力

1. 同一内部thread的advisory lock覆盖恢复、graph执行、全部UserStore副作用与完成回执。
2. checkpoint中的恢复标记只含随机操作UUID，不含用户ID、设备ID、公开threadId或消息正文。
3. 进程在部分副作用完成后失败时，下一请求会在graph继续前恢复原轮次。
4. 已完成步骤依赖业务幂等键安全重放，建议历史不会重复产生记录。
5. 客户端原样重试故障消息时复用原checkpoint结果，不会让对话多走一轮。
6. 故障和恢复由两个不同Pod完成，证明恢复不依赖单进程内存。

## 发布边界

- 正式服务仍保持SQLite，full PostgreSQL门禁仍关闭。
- 本验收只关闭005m的`SIDE_EFFECT_RECOVERY_EVIDENCE_REQUIRED`阻断项。
- 尚余回滚控制面演练、模型依赖监控和独立预生产观察窗口三项。
- 验收档案不保存地址、Pod名称、用户标识、token、HMAC密钥、凭据、证书或回复正文。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

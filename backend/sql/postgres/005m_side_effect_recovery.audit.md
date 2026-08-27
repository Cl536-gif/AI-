# 005m UserStore副作用恢复专项审计

## 范围

本专项只验证独立双实例HTTP灰度服务，不改变正式服务。正式`USER_STORE_ADAPTER=sqlite`
路径和最终full切换门禁保持不变。

## 恢复协议

1. graph输入携带随机UUID格式的`persistenceRequest.operationId`；该标记不含用户ID、
   公开threadId、设备ID或消息正文。
2. 同一内部thread的PostgreSQL advisory lock覆盖“恢复旧轮次、执行新图、顺序写入全部
   UserStore副作用、写完成回执”的完整生命周期。
3. 进程在建议历史写入后退出时，checkpoint保留未完成request且没有匹配receipt。
4. 下一请求必须在图继续前重放完整持久化协调器；各写入自身的幂等键或状态机保证
   已完成步骤不会重复产生业务记录。
5. 如果客户端重试的消息与故障轮次相同，恢复完成后直接复用原checkpoint结果，不再
   invoke graph；不同的新消息则在恢复完成并重新读取长期上下文后进入下一轮。

## 云端验收顺序

- Pod A：`fault`，预期HTTP 503、建议已写、receipt仍pending；
- Pod B：`recover`，使用完全相同的run ID和消息，预期HTTP 200、receipt匹配、建议数不变；
- 任一Pod：`verify`，预期图只含一次相同human消息、建议幂等键无重复、checkpointer未存
  原始标识；
- 任一Pod：`cleanup-checkpointer`，随后按固定DMS清理脚本删除测试用户业务行。

两个Pod必须使用不同实例名称；输出只记录HMAC实例指纹，不记录主机名、内部thread键、
用户标识、token、证书、凭据或回复正文。

## GO边界

只有四阶段均取得真实云端PASS、DMS清理为PASS且证据归档后，才可设置005m副作用恢复
确认。该确认只关闭最终审计中的一个阻断项，不构成生产切换授权。

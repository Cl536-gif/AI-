# 企业微信虚拟凭证完整联调报告

- 日期：2026-08-28
- 仓库基线提交：`cb0d79c`
- Node.js：`v24.18.0`
- npm：`11.16.0`
- 测试入口：`manual-test-wecom-channel-virtual.js`
- 总结：`PASS（8/8）`

## 1. 联调边界

本轮使用 6 项纯虚拟配置：`CorpID`、`AgentID`、应用 Secret、回调 Token、EncodingAESKey、内部 payload key。没有读取或使用真实企业微信凭证。

联调启动了一个仅监听 `127.0.0.1` 的企业微信协议模拟端，通过真实 HTTP 请求完成 `gettoken` 和主动发送消息两个调用；企业微信回调同样通过真实 HTTP 请求进入实际 Express 路由。全程外网请求数为 `0`。

本轮覆盖实际生产代码中的以下链路：

1. URL 验证签名与 AES 解密。
2. 加密消息回调、快速空响应。
3. 入站消息持久化及后台任务领取。
4. 身份、开场、服务选择和 LangGraph 共享调用层。
5. receipt、Outbox、access token 缓存及主动发送。
6. 重复投递幂等。

保护边界：

- `.env.example` 中 `WECOM_CHANNEL_ENABLED=false`。
- 测试进程环境中的正式渠道开关为 `false`。
- 仅向隔离测试路由对象注入启用状态，以便执行协议闭环；没有修改正式部署配置。
- `realCredentialsUsed=false`。
- `externalNetworkRequestCount=0`。

因此，本报告证明的是“虚拟企业微信协议端下的完整代码闭环”，不等同于真实企业微信服务器已经接受回调。真实服务器验收仍须使用真实 CorpID/AgentID/Secret 和企业微信后台回调配置单独执行。

## 2. 执行命令

```sh
cd /Users/macbook/Documents/AI饮食秘书/backend
npm run test:wecom:virtual
```

## 3. 完整原始输出

```text
> diet-secretary-backend@0.1.0 test:wecom:virtual
> node manual-test-wecom-channel-virtual.js

{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"01_production_gate_remains_closed","productionChannelEnabled":false,"processEnvironmentChannelEnabled":false,"disabledConfigAcceptedCount":1,"realCredentialCount":0,"externalNetworkRequestCount":0}
{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"02_get_callback_signature_and_decryption","httpStatus":200,"signatureAcceptedCount":1,"aesDecryptMatchCount":1,"plaintextResponseBytes":15}
{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"03_invalid_protocol_inputs_rejected","invalidSignatureHttpStatus":403,"invalidReceiveIdHttpStatus":403,"invalidAgentHttpStatus":403,"nonAllowlistedMemberHttpStatus":403,"rejectedStoredJobCount":0}
{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"04_encrypted_post_fast_ack_and_intro_push","callbackHttpStatus":200,"callbackResponseBytes":0,"callbackElapsedMs":5,"committedInboundJobCount":1,"completedJobCount":1,"proactiveMessageCount":1,"pricingAssertionCount":2}
{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"05_service_choice_persisted","callbackHttpStatus":200,"freeChoiceMatchedCount":1,"onboardingRowCount":1,"serviceChoiceFreeCount":1,"graphStartedBeforeQuestionCount":0}
{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"06_async_langgraph_and_outbox_closed_loop","callbackHttpStatus":200,"langGraphInvocationCount":1,"businessSideEffectCount":1,"completedJobCount":3,"graphReceiptCount":3,"sentOutboxCount":3,"identityCount":1,"deterministicReplyMatchedCount":1}
{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"07_access_token_cache_and_virtual_upstream","accessTokenFetchCount":1,"proactiveApiRequestCount":3,"acceptedSendCount":3,"tokenCacheReuseCount":2,"outboundAgentIdMatchCount":3,"outboundRecipientMatchCount":3}
{"batch":"wecom-channel-virtual-integration","status":"PASS","name":"08_duplicate_delivery_remains_idempotent","callbackAttemptCount":2,"storedJobCount":1,"secondWorkerClaimedCount":0,"finalLangGraphInvocationCount":1,"finalBusinessSideEffectCount":1,"finalAcceptedSendCount":3}
{"batch":"wecom-channel-virtual-integration","status":"PASS","integrationItemCount":8,"virtualCredentialSetCount":6,"realCredentialsUsed":false,"productionWecomChannelEnabled":false,"externalNetworkRequestCount":0,"encryptedInboundMessageCount":8,"completedBusinessMessageCount":3,"proactiveAcceptedMessageCount":3}
```

进程退出码：`0`。

## 4. 逐项断言

| # | 场景 | 关键断言数字 | 结果 |
|---:|---|---|---|
| 1 | 正式渠道闸门保持关闭 | 模板启用值 `false`；进程启用值 `false`；真实凭证 `0`；外网请求 `0` | PASS |
| 2 | GET 回调验证 | HTTP `200`；签名接受 `1`；AES 明文匹配 `1`；返回明文 `15` 字节 | PASS |
| 3 | 非法输入拒绝 | 错误签名、ReceiveID、AgentID、非白名单成员均为 HTTP `403`；错误消息落库 `0` | PASS |
| 4 | POST 快速确认及开场主动推送 | HTTP `200`；确认响应 `0` 字节；耗时 `5 ms`；入站任务 `1`；完成任务 `1`；主动推送 `1`；定价断言 `2` | PASS |
| 5 | 服务选择持久化 | HTTP `200`；选择匹配 `1`；onboarding 行 `1`；free 选择 `1`；提前启动图 `0` | PASS |
| 6 | LangGraph 与 Outbox 闭环 | LangGraph 调用 `1`；业务副作用 `1`；完成任务 `3`；receipt `3`；已发送 Outbox `3`；身份 `1`；回复匹配 `1` | PASS |
| 7 | token 缓存及主动发送 | token 获取 `1`；主动请求 `3`；上游接受 `3`；缓存复用 `2`；AgentID 匹配 `3`；接收人匹配 `3` | PASS |
| 8 | 重复投递幂等 | 回调尝试 `2`；最终任务 `1`；第二次 worker 领取 `0`；最终 LangGraph 调用 `1`；业务副作用 `1`；主动发送总数 `3`（无新增） | PASS |

## 5. 汇总数字

| 指标 | 数值 |
|---|---:|
| 联调项目 | 8 |
| 虚拟凭证项 | 6 |
| 加密入站请求 | 8 |
| 完成的业务消息 | 3 |
| 主动推送接受数 | 3 |
| 真实凭证使用数 | 0 |
| 外部网络请求数 | 0 |
| 正式渠道启用状态 | false |

## 6. 结论和下一道门槛

虚拟凭证联调通过。当前证据表明签名、AES 加解密、回调快速确认、异步持久化处理、LangGraph、Outbox、主动推送、token 缓存和幂等在隔离协议模拟环境中形成闭环。

本次结果不自动授权以下动作：

- 不打开 `WECOM_CHANNEL_ENABLED`。
- 不写入真实 CorpID、AgentID、Secret、Token 或 EncodingAESKey。
- 不部署到真实企业微信回调地址。
- 不视为真实企业微信服务器联调通过。

下一阶段应由用户再次明确批准后，才使用真实测试企业的凭证，在仍受白名单限制的内部测试环境中执行企业微信后台 URL 验证、真实消息回调和主动推送验证。

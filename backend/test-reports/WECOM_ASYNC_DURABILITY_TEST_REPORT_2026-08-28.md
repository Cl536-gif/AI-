# 企业微信异步通道：崩溃恢复与正常流程回归测试报告

日期：2026-08-28

## 核对说明

- regression 的 13 项都有各自的具体通过证据，并非只有笼统的“13/13 通过”。
- 当前渠道仍保持 `WECOM_CHANNEL_ENABLED=false`。

## 结论

- 真实 `SIGKILL` 崩溃恢复：7/7 通过。
- checkpoint 续跑：通过；父进程在子进程被 `SIGKILL` 后独立读到 `checkpoint_incomplete`，恢复后模型、用户消息及业务副作用均为 1 次。
- 正常流程回归：设计清单实际列出的 13/13 项全部通过。
- 测试期间 `WECOM_CHANNEL_ENABLED=false`；未使用真实企业微信凭证，未进入虚拟凭证联调阶段。
- 测试使用临时、隔离的本机 PostgreSQL 16 集群；每次测试结束后销毁临时集群，不连接生产数据库。

## 一、7 个真实 SIGKILL 崩溃场景

父进程实际调用 `child.kill('SIGKILL')`，并断言子进程退出信号确实为 `SIGKILL`。恢复阶段启动新的 Node.js Worker 进程。

| 场景 | 崩溃后图状态 | 模型调用 | 用户消息 | 业务副作用 | Outbox | 被上游接受 | 上游请求次数 | 最终任务状态 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 入队完成、尚未领取 | absent | 1 | 1 | 1 | 1 | 1 | 1 | completed |
| 取得租约、尚未进入 LangGraph | absent | 1 | 1 | 1 | 1 | 1 | 1 | completed |
| LangGraph 中间 checkpoint 已写入 | checkpoint_incomplete | 1 | 1 | 1 | 1 | 1 | 1 | completed |
| 图结果已生成、持久化回执未写 | persistence_pending | 1 | 1 | 1 | 1 | 1 | 1 | completed |
| 持久化回执已写、任务表尚未更新 | receipt_pending | 1 | 1 | 1 | 1 | 1 | 1 | completed |
| Outbox 已写、尚未发送 | complete | 1 | 1 | 1 | 1 | 1 | 1 | completed |
| 企业微信已接收、发送成功尚未落库 | complete | 1 | 1 | 1 | 1 | 1 | 2 | completed |

最后一项发生了 2 次上游请求，但使用同一个稳定请求 ID；模拟上游去重后 `acceptedSendCount` 仍为 1。

### 完整原始输出

命令：

```bash
npm run test:wecom:crash-recovery
```

输出：

```text
> diet-secretary-backend@0.1.0 test:wecom:crash-recovery
> node tests/wecom/crash-recovery.js

{"batch":"wecom-crash-recovery","status":"PASS","scenario":"01_after_enqueue","crashPoint":"afterEnqueue","childKillSignal":"SIGKILL","persistentCrashMarker":"afterEnqueue","graphMarkerAfterCrash":"absent","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":1,"finalJobStatus":"completed"}
{"batch":"wecom-crash-recovery","status":"PASS","scenario":"02_after_lease","crashPoint":"afterLeaseAcquired","childKillSignal":"SIGKILL","persistentCrashMarker":"afterLeaseAcquired","graphMarkerAfterCrash":"absent","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":1,"finalJobStatus":"completed"}
{"batch":"wecom-crash-recovery","status":"PASS","scenario":"03_checkpoint_resume","crashPoint":"checkpointDurable","childKillSignal":"SIGKILL","persistentCrashMarker":"checkpointDurable","graphMarkerAfterCrash":"checkpoint_incomplete","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":1,"finalJobStatus":"completed"}
{"batch":"wecom-crash-recovery","status":"PASS","scenario":"04_graph_result","crashPoint":"graphResultGenerated","childKillSignal":"SIGKILL","persistentCrashMarker":"graphResultGenerated","graphMarkerAfterCrash":"persistence_pending","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":1,"finalJobStatus":"completed"}
{"batch":"wecom-crash-recovery","status":"PASS","scenario":"05_persistence_receipt","crashPoint":"persistenceReceiptWritten","childKillSignal":"SIGKILL","persistentCrashMarker":"persistenceReceiptWritten","graphMarkerAfterCrash":"receipt_pending","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":1,"finalJobStatus":"completed"}
{"batch":"wecom-crash-recovery","status":"PASS","scenario":"06_outbox_written","crashPoint":"afterOutboxWritten","childKillSignal":"SIGKILL","persistentCrashMarker":"afterOutboxWritten","graphMarkerAfterCrash":"complete","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":1,"finalJobStatus":"completed"}
{"batch":"wecom-crash-recovery","status":"PASS","scenario":"07_upstream_accepted","crashPoint":"afterUpstreamAccepted","childKillSignal":"SIGKILL","persistentCrashMarker":"afterUpstreamAccepted","graphMarkerAfterCrash":"complete","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":2,"finalJobStatus":"completed"}
{"batch":"wecom-crash-recovery","status":"PASS","scenarioCount":7,"realSigkillCount":7,"checkpointResumeScenario":{"scenario":"03_checkpoint_resume","crashPoint":"checkpointDurable","childKillSignal":"SIGKILL","persistentCrashMarker":"checkpointDurable","graphMarkerAfterCrash":"checkpoint_incomplete","langGraphInvocationCount":1,"humanMessageCount":1,"adviceAppliedCount":1,"outboxCount":1,"acceptedSendCount":1,"upstreamRequestAttempts":1,"finalJobStatus":"completed"}}
```

## 二、正常流程回归

设计文档的覆盖列表实际包含 13 项，全部逐项输出具体数字：

| # | 覆盖项 | 关键实测值 |
| ---: | --- | --- |
| 1 | GET 回调验证及 Token 格式 | HTTP 200；解密回显匹配 1；合法 Token 接受 1；非法 Token 拒绝 2 |
| 2 | POST 验签与 AES 解密 | 解密并入队 1；错误签名拒绝 1；错误签名入库 0 |
| 3 | PostgreSQL 提交后快速空 200 | HTTP 200；响应 0 字节；19ms；已提交任务 1 |
| 4 | 正常 Worker 领取 | 领取 1；完成 1 |
| 5 | 开场、定价、选择、注销 | 开场匹配 3；免费选择 1；长期选择 1；共享对话 1；注销请求 1 |
| 6 | LangGraph 共享链路 | 模型调用 1；图回执 1 |
| 7 | access_token 缓存与失效刷新 | Token 获取 2；失效刷新 1；API 请求 3；缓存复用 1 |
| 8 | UTF-8 2048 字节安全截断 | 输入 3000 字节；输出 2046 字节；替换字符 0 |
| 9 | 主动发送 | 尝试 1；上游接受 1 |
| 10 | 重复 MsgId 去重 | 回调 2；任务行 1；第二次 HTTP 200 |
| 11 | 同一成员 FIFO | 首序号 1；并发阻塞 1；次序号 2 |
| 12 | 不同成员并行 | 同时领取 2；不同线程 2 |
| 13 | 渠道关闭隔离 | HTTP 404；Worker 创建 0；活跃 0；网络调用 0 |

### 完整原始输出

命令：

```bash
npm run test:wecom:regression
```

输出：

```text
> diet-secretary-backend@0.1.0 test:wecom:regression
> node tests/wecom/regression.js

{"batch":"wecom-regression","status":"PASS","name":"01_get_callback_verification","httpStatus":200,"decryptedEchoMatches":1,"validCallbackTokenAcceptedCount":1,"invalidCallbackTokenRejectedCount":2}
{"batch":"wecom-regression","status":"PASS","name":"02_post_signature_aes_decryption","httpStatus":200,"decryptedAndQueuedCount":1,"invalidSignatureRejectedCount":1,"invalidSignatureStoredJobCount":0}
{"batch":"wecom-regression","status":"PASS","name":"03_postgres_commit_fast_empty_200","httpStatus":200,"responseBytes":0,"elapsedMs":19,"committedJobCount":1}
{"batch":"wecom-regression","status":"PASS","name":"10_duplicate_msgid_deduplicated","callbackAttempts":2,"storedJobCount":1,"secondHttpStatus":200}
{"batch":"wecom-regression","status":"PASS","name":"04_normal_worker_claim","claimedCount":1,"completedJobCount":1}
{"batch":"wecom-regression","status":"PASS","name":"06_shared_langgraph_path","langGraphInvocationCount":1,"graphReceiptCount":1}
{"batch":"wecom-regression","status":"PASS","name":"09_proactive_send","proactiveSendAttempts":1,"acceptedSendCount":1}
{"batch":"wecom-regression","status":"PASS","name":"05_onboarding_pricing_choices_deletion","introMatchedCount":3,"freeChoiceMatchedCount":1,"longChoiceMatchedCount":1,"sharedConversationCount":1,"deletionRequestCount":1}
{"batch":"wecom-regression","status":"PASS","name":"07_access_token_cache_refresh","tokenFetchCount":2,"invalidTokenRefreshCount":1,"proactiveApiRequestCount":3,"cacheReuseCount":1}
{"batch":"wecom-regression","status":"PASS","name":"08_utf8_safe_2048_truncation","inputBytes":3000,"outputBytes":2046,"replacementCharacterCount":0}
{"batch":"wecom-regression","status":"PASS","name":"11_same_member_fifo","firstClaimSequence":1,"blockedConcurrentClaimCount":1,"secondClaimSequence":2}
{"batch":"wecom-regression","status":"PASS","name":"12_different_members_parallel","concurrentlyClaimedCount":2,"distinctThreadCount":2}
{"batch":"wecom-regression","status":"PASS","name":"13_disabled_no_route_worker_or_network","callbackHttpStatus":404,"workerCreatedCount":0,"workerActiveCount":0,"networkCallCount":0}
{"batch":"wecom-regression","status":"PASS","regressionItemCount":13,"wecomChannelEnabledDuringTests":false,"realCredentialsUsed":false}
```

## 三、门禁状态

本报告只证明编码实现、真实强杀恢复和正常流程回归通过。它不代表已经获准进入下一阶段：

```text
WECOM_CHANNEL_ENABLED=false
虚拟凭证联调：未执行
真实企业微信联调：未执行
```

下一阶段仍需用户单独审核和明确批准。

## 四、逐项核对结论

- 7 个场景都有独立原始记录。
- 每个场景的模型调用、用户消息、业务副作用和 Outbox 都是 `1`。
- 最终任务状态全部是 `completed`。
- 第 7 个场景上游请求为 `2`，但上游实际接受次数为 `1`，验证了稳定请求 ID 去重。
- regression 13 项均有独立 JSON 证据及具体计数。
- 当前没有批准或打开企业微信渠道。

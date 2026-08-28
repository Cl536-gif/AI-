# LangGraph 与本地知识库烟雾测试报告

- 日期：2026-08-28
- 测试性质：不依赖企业微信、不使用真实渠道凭证的本地烟雾验证
- 测试入口：现有 LangGraph HTTP 测试与本地知识库检索桥接层
- 总结：`PASS（2/2）`

## 1. 验证边界

本轮只验证以下两件事：

1. `/api/chat-langgraph` 共享 HTTP 链路在进入长期上下文、LangGraph 和持久化前，会先等待身份解析完成；无效设备标识会在调用图之前被拒绝。
2. `localKbBridge.retrieveFromKbs()` 能从 `diet` 和 `body-composition` 两个本地知识库返回实际检索片段，且没有进入空结果降级模式。

本轮没有调用真实企业微信服务器，没有使用企业微信真实凭证，也没有打开任何公网回调入口。知识库测试只核对检索层，不调用外部大模型，因此不产生模型费用，也不把检索片段正文写入报告。

本轮不等同于：

- 完整六项信息采集与 `generatePlan` 真人多轮质量验收；
- 模型最终回复事实准确性或语言风格验收；
- 企业微信真实 URL 验证、真实消息回调或主动推送验收。

## 2. LangGraph HTTP 链路

执行命令：

```sh
cd /Users/macbook/Documents/AI饮食秘书/backend
node manual-test-chat-langgraph-async-http.js
```

完整原始输出：

```json
{"batch":"004p-chat-langgraph-async-http","status":"PASS","identityAwaitedBeforeContext":true,"identityAwaitedBeforeGraph":true,"identityAwaitedBeforePersistence":true,"invalidDeviceRejectedBeforeGraph":true}
```

关键断言：

| 断言 | 实测值 | 结果 |
| --- | --- | --- |
| 长期上下文前等待身份解析 | `true` | PASS |
| LangGraph 调用前等待身份解析 | `true` | PASS |
| 持久化前等待身份解析 | `true` | PASS |
| 无效设备标识在调用图前被拒绝 | `true` | PASS |

## 3. 本地知识库实际检索

测试问题：

```text
局部减脂是否可行，体重和体脂应该怎样判断？
```

执行方式：直接调用生产代码中的 `src/services/localKbBridge.js`，分别查询 `diet` 和 `body-composition`。

完整原始输出：

```json
{"batch":"local-kb-retrieval-smoke","status":"PASS","question":"局部减脂是否可行，体重和体脂应该怎样判断？","knowledgeBaseCount":2,"results":[{"kbName":"diet","chunkCount":5,"error":null,"topHybridScore":0.5471254362094984,"sourceCount":4},{"kbName":"body-composition","chunkCount":5,"error":null,"topHybridScore":0.4892569634729844,"sourceCount":1}],"responseContentEmitted":false}
```

关键断言：

| 知识库 | 返回片段 | 错误 | 最高混合分 | 不同来源数 | 结果 |
| --- | ---: | --- | ---: | ---: | --- |
| `diet` | 5 | `null` | 0.5471254362094984 | 4 | PASS |
| `body-composition` | 5 | `null` | 0.4892569634729844 | 1 | PASS |

隐私边界：`responseContentEmitted=false`，报告没有输出知识库正文。

## 4. 结论与后续门槛

当前证据证明 LangGraph 共享 HTTP 链路的关键顺序未回归，且两个本地知识库都能返回真实检索结果。

后续仍应使用 `public/compare-v2.html` 或等价测试方式单独完成以下人工质量验收：

1. 左侧 `/api/chat-local` 与右侧 `/api/chat-langgraph` 使用同一问题逐轮对比。
2. 完成六项信息采集并进入 `generatePlan`。
3. 核对最终方案确实使用了与问题相关的知识库证据，而不是只出现通用回答。
4. 对“局部减脂”“体重波动”“体脂判断”等问题检查引用内容与结论是否一致。
5. 将问题、必要的脱敏回复、命中知识库、片段数量、人工判定和失败原因保存为独立 Markdown 报告。

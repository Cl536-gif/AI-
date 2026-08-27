# 005o 百炼模型依赖发布前监控门禁

## 目标

在独立临时服务执行两次不含用户数据的最小真实请求，同时验证生产百炼应用接口和LangGraph使用的qwen-plus兼容接口。两条请求均成功才证明验证时刻的API Key、App ID、账户可用状态及模型服务能够承担发布流量。

## 边界

- 临时服务：`diet-secretary-model-monitor-005o`，构建目录`backend`，单实例。
- `USER_STORE_ADAPTER=sqlite`、`LANGGRAPH_CHECKPOINTER_BACKEND=memory`；禁止任何PostgreSQL full/canary配置。
- 真实探针固定发送“仅回复OK”，不发送用户标识、档案、历史消息或业务正文。
- 不输出API Key、App ID、请求ID或模型回复；只输出健康状态、HTTP状态和延迟。
- 005o不声称读取百炼余额数字。两次可计费请求成功只证明账户当时处于可调用状态；欠费会被分类为`BAILIAN_MONITOR_ACCOUNT_STANDING_FAILED`并失败关闭。

## 环境变量

```text
NODE_ENV=production
PORT=3001
USER_STORE_ADAPTER=sqlite
LANGGRAPH_CHECKPOINTER_BACKEND=memory
BAILIAN_API_KEY=<沿用正式服务当前有效值>
BAILIAN_APP_ID=<沿用正式服务当前有效值>
BAILIAN_MONITOR_TIMEOUT_MS=20000
RUN_005O_MODEL_MONITOR_VERIFY=CONFIRMED_005O_BAILIAN_MODEL_MONITOR
RUN_005O_DEDICATED_SERVICE=CONFIRMED_005O_DEDICATED_MODEL_MONITOR_SERVICE
RUN_005O_LIVE_PROBE=CONFIRMED_005O_LIVE_BAILIAN_PROBE
```

## 执行

```sh
node manual-test-bailian-model-monitor-cloud-guard.js
node manual-test-bailian-model-monitor-cloud.js
```

守卫必须PASS且不使用网络；真实探针必须输出`applicationProbe=healthy`、`genericProbe=healthy`、两个HTTP 200、`accountStanding=verified_by_successful_billable_requests`以及`responseContentEmitted=false`。

## 失败分类

- 欠费、余额不足、账户冻结：`BAILIAN_MONITOR_ACCOUNT_STANDING_FAILED`
- API Key或App鉴权失败：`BAILIAN_MONITOR_AUTHENTICATION_FAILED`
- 限流：`BAILIAN_MONITOR_RATE_LIMITED`
- 超时：`BAILIAN_MONITOR_TIMEOUT`
- 上游5xx：`BAILIAN_MONITOR_UPSTREAM_UNAVAILABLE`
- 网络故障或返回格式异常：对应网络/响应错误码

任何FAIL均禁止关闭最终模型监控阻塞项。验收通过并归档后删除临时服务；正式服务配置不在本阶段改变。

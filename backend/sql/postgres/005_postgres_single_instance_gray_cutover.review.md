# 005 PostgreSQL 单实例灰度与回滚方案（审核稿）

状态：门禁实现候选；尚未切换任何CloudBase实例。

## 1. 目标与边界

首次业务流量验证只允许单实例、单连接池的可回滚灰度，不做双写，不覆盖现有SQLite数据，不直接开放全量流量。

- 当前稳定版本继续使用`USER_STORE_ADAPTER=sqlite`。
- 灰度版本使用独立CloudBase修订，最大实例数固定为1。
- PostgreSQL连接池上限固定为1，先验证正确性与事务边界，不测试吞吐上限。
- 全量切换仍由`isTencentPostgresCutoverReady()`失败关闭。

## 2. 启动门禁

选择`tencent-postgres`时必须同时满足：

```text
TENCENT_PG_CUTOVER_MODE=single_instance_canary
TENCENT_PG_CUTOVER_CONFIRM=postgres-single-instance-canary
TENCENT_PG_CANARY_MAX_INSTANCES=1
TENCENT_PG_POOL_MAX=1
```

这些值不是密钥，只是防误操作声明；真实密码和连接信息继续由CloudBase环境变量注入，不进入Git或验收材料。

任一声明缺失、实例声明不为1、连接池不为1或模式未知时，服务启动失败关闭。`full`模式在正式门槛变为true前始终拒绝。

## 3. 灰度前置条件

1. 当前SQLite稳定版本、提交号和回滚入口已记录。
2. PostgreSQL `/api/ready`返回200，数据库名、角色和空用户上下文一致。
3. 37/37 UserStore方法均已分类为`database_ready`，0项未分类。
4. 004c–004m数据库与适配器云端验收、004n Provider、004o应用服务和004p LangGraph正式路由均已归档。
5. 百炼真实聊天仍返回200；不得以模型配置错误误判数据库灰度。
6. CloudBase灰度修订的最大实例数在控制台实际设为1，并与门禁声明一致。

## 4. 灰度执行顺序

1. 从当前稳定提交创建新CloudBase修订，不修改稳定修订环境变量。
2. 新修订设置PostgreSQL适配器及四项门禁变量，最大实例数设为1。
3. 暂不导入真实用户历史；使用新的专用匿名测试身份。
4. 先检查`/api/health`与`/api/ready`。
5. 执行Provider、能力清单、应用服务、LangGraph异步边界和关键用户路径包内回归。
6. 执行真实`/api/chat-langgraph`新用户首轮、第二轮上下文读取、直接提问和非法身份拒绝。
7. 只在所有结果通过后保留短观察窗口；不扩大实例数或流量范围。

## 5. 通过标准

- 启动、健康和数据库就绪检查全部200。
- 身份解析、档案写入、活动记录、建议记录和后续读取成功。
- RLS上下文在事务结束后清空，无跨用户可见数据。
- 同一请求的应用写入保持串行，连接池上限1时无连接耗尽。
- 错误日志只出现安全错误码，不含SQL、参数或连接信息。
- SQLite稳定修订始终可立即重新部署。

## 6. 立即回滚条件

任一情况发生即停止灰度并将服务恢复到SQLite稳定修订：

- `/api/ready`非200或出现身份不匹配。
- HTTP 5xx、连接池超时、事务回滚失败或RLS隔离异常。
- 匿名身份不稳定、档案/建议写入丢失、重复写入或读取不一致。
- 模型聊天正常但数据库副作用失败。
- 日志出现连接配置、SQL参数或用户敏感内容。

回滚只切回稳定修订，不在故障期间临时修改数据库表、放宽权限或开启双写。灰度测试数据后续通过受控清理流程处理。

## 7. 本批不做

- 不修改CloudBase线上环境变量。
- 不创建、轮换或记录任何凭据。
- 不把PostgreSQL设为默认Provider。
- 不把`isTencentPostgresCutoverReady()`改为true。
- 不执行全量或多实例切换。

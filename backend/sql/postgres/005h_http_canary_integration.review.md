# 005h 正式LangGraph HTTP链路受控接入评审

状态：`LOCAL_CLOUD_CANDIDATE`。独立双实例HTTP灰度模式及云验证器已完成本地门禁，不放宽full门禁，不修改默认SQLite路径。

## 进入条件

1. UserStore与checkpointer均使用共享PostgreSQL，避免两个Pod的本地SQLite身份映射分裂。
2. 独立验证服务确认、UserStore灰度确认、checkpointer确认和同thread锁确认必须同时存在。
3. 最大实例固定2、每实例连接池固定2；容量正式预算仍由005i处理。
4. 至少32字符的服务端canary令牌必须配置；缺令牌、错误令牌在身份解析和数据库副作用前返回拒绝。
5. thread作用域继续使用服务端身份与HMAC内部键，不接受请求正文伪造正式账号。

## 请求边界

1. 只有新`dual_instance_http_canary`模式要求令牌和同thread advisory lock。
2. 锁覆盖完整`graph.invoke`，checkpointer读取与写入在同一thread内线性化。
3. 身份解析、长期上下文读取和图后UserStore副作用暂不放入同一锁；005h云端故障注入必须验证其幂等与最终收敛。
4. 默认SQLite和既有单实例模式不增加令牌或锁。
5. 仅在005h专用服务且持有正确令牌时，响应附带HMAC实例指纹和锁等待毫秒数；不返回Pod名、用户ID、内部thread键或数据库标识。
6. 受控故障头只在`RUN_005H_FAULT_INJECTION=CONFIRMED_005H_HTTP_CANARY_FAULT_INJECTION`时生效；可在身份幂等解析后、图执行前返回503，或在锁内短暂保持最多15秒以制造真实跨Pod重叠。

## 本批不证明

- 全量连接容量、自动扩缩容或监控阈值。
- SQLite真实数据迁移、稳定回滚制品、备份恢复或TLS签核。
- 进程强杀后的完整HTTP副作用已自动收敛。
- 正式生产流量可启用；`productionReady`继续为false。

## 云端退出标准草案

1. 独立双Pod服务中，同一匿名身份与thread跨Pod连续多轮HTTP恢复。
2. 两个重叠HTTP请求形成锁等待，不产生checkpoint分支或重复UserStore副作用。
3. 滚动重启后继续同一thread，重复请求能够幂等收敛。
4. 错令牌、缺令牌、错误实例/池声明均在副作用前失败关闭。
5. 固定测试身份、thread、建议、事件及checkpoint精确清理为0，并删除临时部署。

## 云验证顺序

1. DMS执行`005h_http_canary_preflight.review.sql`，必须返回固定测试身份不存在。
2. 两Pod使用同一新run ID；依次执行`boundary`、`writer`，另一Pod执行`reader`，确认恢复了既有checkpoint且实例指纹不同。
3. Pod A执行`contender-a`并在锁内保持10秒，立即从Pod B执行`contender-b`；B必须报告锁等待至少500毫秒。
4. 执行`replay-marker`证明UserStore验证标记幂等，随后执行`verify`，必须得到双实例、线性checkpoint链、零分支、真实HTTP建议已持久化且原始标识未进入checkpointer。
5. 先执行`cleanup-checkpointer`证明checkpoint零残留，再由DMS执行`005h_http_canary_cleanup.review.sql`清理固定匿名身份及其全部从属数据。
6. 删除临时部署并确认实例归零；在这些步骤全部完成前，005h不得标记完成。

## 已知边界

- 建议历史依靠既有`threadId + 内容摘要`幂等键；云验证器额外重放固定实例标记，证明数据库幂等RPC有效，但不把任意模型生成请求宣称为端到端exactly-once。
- `after-identity`故障证明身份创建后重试可收敛，尚不证明进程在graph checkpoint写入后、所有UserStore副作用完成前崩溃可自动恢复；该窗口仍是005h云验后的Go/No-Go审查项。

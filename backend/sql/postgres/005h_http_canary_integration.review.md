# 005h 正式LangGraph HTTP链路受控接入评审

状态：`LOCAL_GATED`。本批只增加独立双实例HTTP灰度模式，不放宽full门禁，不修改默认SQLite路径。

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

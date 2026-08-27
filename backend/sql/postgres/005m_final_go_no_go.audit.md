# 005m PostgreSQL最终Go/No-Go审计

## 当前决定

`NO_GO`。005a–005l已经形成可追溯证据，005m副作用恢复专项、005n CloudBase控制面回滚演练与005o百炼模型依赖监控均已完成真实云端验收；当前仅缺少以下一项真实运行证据：

1. 独立预生产环境至少60分钟、至少100请求且七类失败/等待计数均为0的观察窗口。

## 已满足证据

- 37个生产UserStore方法均映射到真实云端验收档案；矩阵位于`005m_method_evidence_matrix.review.csv`。
- 共享checkpointer、双实例恢复、同thread并发与正式HTTP链路已经由005e–005h覆盖。
- 容量预算和回滚信号计算由005i覆盖。
- SQLite数据去向、稳定回滚制品和隔离PITR分别由005j、005k、005l覆盖。
- graph成功后UserStore部分副作用故障、跨Pod恢复、幂等重放、相同消息短路与精确清理由`docs/acceptance/005m-side-effect-recovery/`覆盖。
- 005i回滚信号触发同一CloudBase临时服务从灰度修订回到原稳定SQLite修订的控制面动作由`docs/acceptance/005n-cloudbase-rollback-control/`覆盖。
- 百炼应用接口与qwen-plus兼容接口的真实请求、账户可用性、失败分类和回复隐私边界由`docs/acceptance/005o-bailian-model-monitor/`覆盖。
- 所有既有full请求仍由能力门禁失败关闭；005m再增加独立最终运行门禁。

## GO最低条件

- 固定确认37方法证据矩阵和所有引用验收包MANIFEST完整性；
- 完成副作用恢复、回滚控制面和模型依赖监控三项专项验收；三项均已完成；
- 完成独立预生产观察窗口：不少于60分钟和100请求；readiness、连接超时、事务、身份、副作用、HTTP 5xx和池等待最大值均为0；
- 最终生产切换仍需要用户另行明确授权，不由005m脚本自动执行。

## 禁止事项

- 不得用手填确认值替代真实观察和专项验收；
- 不得批量把能力字符串改成`implemented_and_verified`来绕过门禁；
- 不得在正式服务直接配置full模式来“试运行”；
- 不得把地址、凭据、证书、token、用户标识或回复正文写入证据。

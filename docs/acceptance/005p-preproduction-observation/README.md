# 005p 独立预生产观察窗口验收

## 结论

`PASS`。独立CloudBase临时服务以双实例运行PostgreSQL UserStore、共享PostgreSQL checkpointer和受保护HTTP入口，连续观察60分钟并完成100个真实请求。

- 请求：100/100成功。
- 实例：观测到2个不同实例指纹。
- 零信号：readiness失败、连接超时、事务失败、身份失败、副作用失败、HTTP 5xx、连接池等待最大值和响应格式失败均为0。
- 数据边界：不输出回复正文、用户ID、内部thread键、凭据或证书。
- 清理：100个正式观察thread的checkpointer清零；DMS精确清理101条建议记录（含1条修复后写入烟测），身份、用户和建议残留均为0。

## 重试审计

初始脚本使用未明确餐次的“通用一餐”提示语，100个HTTP请求本身全部成功且命中双实例，但LangGraph按首次资料采集处理，导致`advicePersistence`均为`unchanged`，观察按副作用门禁失败。提交`0d15f22`将提示语改为明确的午餐问题；重新部署后先以单请求证明`advicePersistence=recorded`，清理烟测checkpointer，再以新批次完成正式60分钟观察。

失败批次没有被当作通过证据；最终结论只依据修复后的正式观察批次。

## 证据范围

- 批次：`005p-preproduction-observation`
- 临时服务：`diet-secretary-preproduction-005p`
- 最终发布修订：`003`
- 正式观察run ID：`005p-cloud-20260827-03`
- 实现提交：`e4c1741`、`0d15f22`

## 发布边界

005p关闭最终审查中最后一项“独立预生产观察窗口”证据缺口。最终证据审查可以给出`GO`且阻塞项为0，但本验收不修改正式服务、不自动启用PostgreSQL全量模式；生产切换仍需用户另行明确授权并经过现有全量门禁。

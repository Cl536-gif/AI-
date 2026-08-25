# 005c PostgreSQL 受控真实 HTTP 灰度验收

验收日期：2026-08-25（Asia/Shanghai）

## 结论

005c 已完成单实例 PostgreSQL 真实 HTTP 写入、双 Store 根因修复、稳定 SQLite 回滚、精确清理和独立零残留复核。

- HTTP 前置检查：`PASS`
- 单实例 PostgreSQL 运行门禁：`PASS`
- LangGraph 动态 Provider 回归：`PASS`
- 真实 HTTP 匿名身份解析：`PASS`
- PostgreSQL 建议真实持久化：`PASS`
- 恢复 SQLite 稳定修订及健康检查：`PASS`
- 固定测试数据精确清理：`PASS`
- 清理后独立 preflight：`PASS`
- 全量 PostgreSQL 切换：仍为失败关闭

## 故障与修复

首次真实 HTTP 响应报告建议已记录，但目标 PostgreSQL 建议表计数为零。定位发现默认图持久化协调器在模块加载期捕获了 SQLite Store，而运行时身份服务使用随后配置的 PostgreSQL Provider，形成身份与建议分属两个 Store 的问题。

修复后，默认协调器在每次请求开始时解析当前 Provider，并在同一轮持久化中固定该 Store；显式注入的测试 Store 保持原有行为。回归测试覆盖“模块先加载、Provider 后切换”，并同时核对上下文读取和实际建议记录。

## 已验证边界

1. 灰度前数据库对象完整，固定测试身份不存在。
2. PostgreSQL 修订保持单实例、连接池上限 1 和显式灰度确认门禁。
3. 修复版真实 HTTP 返回 200，匿名身份解析成功，建议状态为 recorded。
4. cleanup 在目标库观察到至少一条建议后，精确删除固定测试用户的身份、用户和建议记录。
5. cleanup 输出身份、用户、建议残留均为 0。
6. cleanup 后独立 preflight 再次证明固定测试身份不存在。
7. 服务已切换至新建 SQLite 稳定修订，运行时 Provider 为 SQLite，健康端点返回 200。

## 发布边界

- 本次只使用受控测试身份，不迁移真实用户数据。
- 不启用双写，不放宽数据库权限，不修改表结构。
- 本次通过只证明受控单实例真实 HTTP 路径，不授权全量 PostgreSQL 切换。
- 空档案回复使用具体就餐场景示例的问题作为独立事实约束回归继续处理。
- 归档不保存设备值、身份摘要、用户 ID、线程 ID、Pod 标识、连接信息或凭据。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

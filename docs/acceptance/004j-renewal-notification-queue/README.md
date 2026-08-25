# 004j PostgreSQL 续费提醒与通知队列云端验收

验收日期：2026-08-25（Asia/Shanghai）

## 结论

004j 续费提醒与通知队列已在腾讯云 PostgreSQL `diet_secretary` 完成部署，并在 CloudBase 版本021通过真实私网数据库回滚沙箱验收。

- 部署前只读检查：`PASS`
- 正式迁移：执行成功
- 部署后结构、RLS、权限、索引和函数检查：`PASS`
- 入队返回可见性repair：执行成功，增强postflight `PASS`
- DMS功能回滚沙箱：5/5项 `PASS`，清理 `PASS`
- CloudBase版本021真实PostgreSQL适配器验证：8/8项 `PASS`
- 最终清理：`PASS`
- 线上业务存储适配器：仍为 `sqlite`

## 已验证能力

1. 第13天续费提醒仅在计划时间到达且体验尚未到期时入队。
2. 用户与体验开始时间组成幂等键，首次入队和重复调度返回同一条通知。
3. 入队函数通过`INSERT ... RETURNING`合并新旧幂等行，首次调用即可返回新建通知。
4. 后台可按计划时间和上限读取全局pending队列，上限限制为1–500条。
5. 发送确认只允许pending通知成功一次，重复确认返回`false`。
6. 通知表启用RLS，`diet_app`和PUBLIC均无直接表权限；后台操作只能通过受控函数。
7. 适配器正确映射通知字段、计数和UTC时间，并使用参数化RPC查询。
8. CloudBase验证受显式确认、SQLite保持和RFC1918私网地址护栏保护。
9. DMS与CloudBase沙箱回滚后，测试用户、服务状态、转换记录和通知均无残留。

## 能力清单

- UserStore契约方法：38
- PostgreSQL数据库已就绪：32
- 仍需数据库结构：4
- 仍需契约调整：2
- PostgreSQL生产切换条件：尚未满足

## 验证过程说明

首次DMS功能沙箱在“到期入队或幂等重试”断言处中止。根因是数据修改CTE与主查询共享旧快照：同一语句重新查询通知表时看不到刚插入的新行。事务没有`COMMIT`，未留下测试数据。

修复将新行改由`INSERT ... RETURNING *`直接提供，并通过`resolved_notifications`与旧快照中已有幂等行合并。独立repair脚本只替换入队函数、不重建通知表；增强postflight确认云端函数定义包含两项修复标记。修复后DMS 5项功能断言及四类零残留检查通过。

## 数据边界

- 证据只保存布尔结果、计数、白名单错误码和沙箱汇总。
- 不保存真实用户ID、身体数据、通知内容、密码、数据库地址或连接串。
- DMS与CloudBase功能验证均使用回滚沙箱。
- 本批未修改`USER_STORE_ADAPTER`；CloudBase版本021验证时线上业务存储仍为SQLite。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

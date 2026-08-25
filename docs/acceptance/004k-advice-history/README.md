# 004k PostgreSQL 建议历史云端验收

验收日期：2026-08-25（Asia/Shanghai）

## 结论

004k 建议历史已在腾讯云 PostgreSQL `diet_secretary` 完成部署，并在 CloudBase 版本022通过真实私网数据库回滚沙箱验收。

- 部署前只读检查：`PASS`
- 正式迁移：执行成功
- 部署后结构、RLS、权限、索引和函数检查：`PASS`
- DMS功能回滚沙箱：4/4项 `PASS`，清理 `PASS`
- CloudBase版本022真实PostgreSQL适配器验证：8/8项 `PASS`
- 最终清理：`PASS`
- 线上业务存储适配器：仍为 `sqlite`

## 已验证能力

1. 建议历史按用户、创建时间和建议ID稳定倒序读取。
2. `(user_id, idempotency_key)`保证用户级幂等；重复写入返回首次快照而不覆盖正文、元数据、线程或创建时间。
3. 不同用户可以安全复用同一幂等键，且通过RLS互不可见。
4. `diet_app`仅可读取本人建议，写入必须经过`SECURITY DEFINER`函数。
5. 未知字段、错误JSON类型、空正文、空幂等键及超限内容被拒绝。
6. 适配器正确映射建议字段、JSON元数据和UTC时间，并限制历史列表为1–200条。
7. CloudBase验证受显式确认、SQLite保持和RFC1918私网地址护栏保护。
8. DMS与CloudBase沙箱回滚后，测试用户和建议记录均无残留。

## 能力清单

- UserStore契约方法：38
- PostgreSQL数据库已就绪：34
- 仍需数据库结构：2
- 仍需契约调整：2
- PostgreSQL生产切换条件：尚未满足

## 数据边界

- 证据只保存布尔结果、计数、白名单状态和沙箱汇总。
- 不保存真实用户ID、建议正文、身体数据、密码、数据库地址或连接串。
- DMS与CloudBase功能验证均使用回滚沙箱。
- 本批未修改`USER_STORE_ADAPTER`；CloudBase版本022验证时线上业务存储仍为SQLite。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

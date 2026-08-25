# 004i PostgreSQL 计划修订命令持久化云端验收

验收日期：2026-08-25（Asia/Shanghai）

## 结论

004i 计划修订命令持久化已在腾讯云 PostgreSQL `diet_secretary` 完成部署，并在 CloudBase 版本020通过真实私网数据库回滚沙箱验收。

- 部署前只读检查：`PASS`
- 正式迁移：执行成功
- 部署后结构、RLS、权限、索引和函数检查：`PASS`
- DMS功能回滚沙箱：5/5项 `PASS`，清理 `PASS`
- CloudBase版本020真实PostgreSQL适配器验证：8/8项 `PASS`
- 最终清理：`PASS`
- 线上业务存储适配器：仍为 `sqlite`

## 已验证能力

1. `command_id`全局唯一，命令与当前用户计划通过复合外键绑定。
2. 命令状态仅允许`draft_created`和`delivered`，并通过受控RPC单向推进。
3. 同一用户、命令和计划可安全重试，保留`created_at`并推进`updated_at`。
4. 已交付命令不能回退为草稿，同一命令不能重新绑定其他计划。
5. 跨用户命令ID复用以SQLSTATE `23505`拒绝，其他用户通过RLS读取结果为空。
6. `diet_app`仅可读取本人命令，写入必须经过`SECURITY DEFINER`函数。
7. 适配器正确映射命令、计划、状态和UTC时间，并使用参数化查询。
8. CloudBase验证受显式确认、SQLite保持和RFC1918私网地址护栏保护。
9. DMS与CloudBase沙箱回滚后，测试用户、服务、计划、计划历史和命令均无残留。

## 能力清单

- UserStore契约方法：38
- PostgreSQL数据库已就绪：29
- 仍需数据库结构：7
- 仍需契约调整：2
- PostgreSQL生产切换条件：尚未满足

## 验证过程说明

首次迁移执行后，DMS仍显示上一条preflight结果；再次执行迁移时返回目标表已存在。随后只读postflight的14项结构检查全部通过，证明首次迁移已经完整提交，重复执行没有造成部分变更。

DMS功能沙箱首次遗漏了允许计划启用的服务状态，在既有004g护栏处中止且事务没有提交。脚本随后通过受控RPC为固定沙箱用户设置`subscribed`前置，增加静态断言并在新会话重跑；修复后的5项功能结果和最终清理全部通过。

## 数据边界

- 证据只保存布尔结果、计数、白名单错误码和沙箱汇总。
- 不保存真实用户ID、计划内容、身体数据、密码、数据库地址或连接串。
- DMS与CloudBase功能验证均使用回滚沙箱。
- 本批未修改`USER_STORE_ADAPTER`；CloudBase版本020验证时线上业务存储仍为SQLite。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

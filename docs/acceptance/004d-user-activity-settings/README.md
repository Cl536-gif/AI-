# 004d PostgreSQL 用户活跃与设置云端验收

验收日期：2026-08-24（Asia/Shanghai）

## 结论

004d 用户活跃时间与设置结构已在腾讯云 PostgreSQL `diet_secretary` 完成部署，并在 CloudBase 版本015通过真实私网数据库回滚沙箱验收。

- 部署前只读检查：`PASS`
- DMC SQL变更执行：成功
- 部署后对象、权限与数据形状检查：`PASS`
- DMC功能回滚沙箱：全部 `PASS`，清理 `PASS`
- CloudBase版本015真实PostgreSQL适配器验证：8/8项 `PASS`
- 最终测试用户残留：0
- 线上业务存储适配器：仍为 `sqlite`

## 已验证能力

1. 首次 `recordActivity` 创建active用户，返回空的 `previousActiveAt` 和数据库当前时间。
2. 再次记录活跃时间时，返回的前次时间与上次写入一致，时间单调不倒退。
3. 新用户默认时区为 `Asia/Shanghai`、默认语言为 `zh-CN`。
4. `updateUserTimezone` 可保存并重新读取有效IANA时区 `UTC`。
5. 无效时区以SQLSTATE `22023` 拒绝，原时区保持不变。
6. 用户B无法读取用户A的设置，RLS隔离有效。
7. `diet_app` 无权直接更新 `app.users`，只能调用受控SECURITY DEFINER RPC。
8. 事务回滚后测试用户残留为0。

## 修复轨迹

- 初版只读后置检查误用PostgreSQL保留关键字 `constraint` 作为别名；在只读查询解析阶段失败，未修改数据库。别名修正后检查通过。
- CloudBase版本014部署后，在执行验收前发现RPC时间字符串可能使用 `+00:00`，普通列读取使用 `Z`。适配器统一规范为ISO 8601 UTC格式后部署版本015。
- 首次Webshell命令因确认变量未在同一行传入而被安全门以 `VERIFY_CONFIRMATION_REQUIRED` 拒绝；未连接数据库。改为单行命令后完成8项验收。

## 数据边界

- 迁移只在 `app.users` 增加 `last_active_at`、`timezone`、`locale`，不返回或归档真实用户标识与设置值。
- 功能验证使用固定或随机沙箱用户，并在同一事务内回滚。
- 云端证据不包含密码、数据库地址或连接串。
- 本批未修改 `USER_STORE_ADAPTER`；CloudBase版本015验证时线上业务存储仍为SQLite。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

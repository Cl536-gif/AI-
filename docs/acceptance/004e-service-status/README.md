# 004e PostgreSQL 服务状态云端验收

验收日期：2026-08-24（Asia/Shanghai）

## 结论

004e 用户服务状态与转换历史已在腾讯云 PostgreSQL `diet_secretary` 完成部署，并在 CloudBase 版本016通过真实私网数据库回滚沙箱验收。

- 部署前只读检查：`PASS`
- DMC SQL变更：已提交并由部署后检查确认完整生效
- 部署后对象、约束、RLS与权限检查：`PASS`
- DMC功能回滚沙箱：全部 `PASS`，清理 `PASS`
- CloudBase版本016真实PostgreSQL适配器验证：8/8项 `PASS`
- 最终清理：`PASS`
- 线上业务存储适配器：仍为 `sqlite`

## 已验证能力

1. 状态按 `NULL → onboarding_incomplete → profile_confirmed → trial_active` 原子更新。
2. 每次状态写入追加一条转换历史，初始 `fromStatus` 为空。
3. 体验开始、第13天提醒和第14天结束时间按统一UTC格式返回。
4. 业务层 `{...current}` 携带的 `userId`、`updatedAt` 不会发送到数据库RPC。
5. `trial_expired` 更新保留既有体验周期和正式方案ID。
6. 无效状态和非法时间顺序以SQLSTATE `22023` 拒绝，且不产生新历史。
7. 用户B无法读取用户A的当前状态或转换历史。
8. `diet_app` 只能读取自己的服务状态；写入必须经过SECURITY DEFINER RPC。
9. 沙箱事务回滚后用户、当前状态和转换历史残留均为0。

## 执行说明

DMC曾返回一次 `syntax error at or near "constraint"`。检查当前编辑器和执行历史后发现，完整脚本的函数授权、注释与最终 `COMMIT` 均已成功；随后只读后置检查确认两张表、七个检查约束、两条RLS策略、索引、RPC所有权和最小权限全部存在且正确。因此该错误判定为编辑器局部执行光标附近片段，不是完整迁移失败。

## 数据边界

- 证据仅保存对象状态、布尔结果、计数和白名单错误码。
- 不归档真实用户ID、服务状态内容、支付引用、密码、数据库地址或连接串。
- DMC与CloudBase功能验证均使用回滚沙箱。
- 本批未修改 `USER_STORE_ADAPTER`；CloudBase版本016验证时线上业务存储仍为SQLite。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

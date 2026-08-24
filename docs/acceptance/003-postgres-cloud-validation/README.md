# 003 PostgreSQL 连接池云端验收档案

归档日期：2026-08-24（Asia/Shanghai）

## 结论

003 PostgreSQL 连接基础已在腾讯云 CloudBase Run 部署版本 `010` 上完成云端验收。

- 服务地址：`https://diet-secretary-api-300401-8-1467131986.sh.run.tcloudbase.com`
- `GET /api/health`：HTTP 200，`{"status":"ok"}`
- `GET /api/ready`：HTTP 200，`{"status":"ready"}`
- 003d 私网云端验证：12/12 项检查 `PASS`
- 最终清理：`PASS`，剩余测试用户 0、剩余测试事件 0
- 验收代码提交：`c8e2518`（连接基础：`5fda36f`；就绪错误分类：`347a8c5`）

原始逐项结果保存在 `raw-results.jsonl`，未保存密码、数据库地址、完整环境变量或其他密钥。

## 验收范围

本次验证覆盖：

1. 云端运行实例连接到预期 PostgreSQL 数据库与角色。
2. 就绪检查成功，借用连接前后用户上下文为空。
3. 同一后端连接（PID `71421`）依次处理用户 A、清理上下文、再处理用户 B，跨用户可见记录为 0。
4. SQL 错误 `22012` 后事务正确回滚，连接可继续使用。
5. RLS 与幂等 RPC 在回滚沙箱内通过：跨用户记录 0、只创建 1 条 RPC 记录、重放结果一致。
6. `diet_app` 直接写入受保护表被以 `42501` 拒绝。
7. 沙箱事务回滚后，测试用户和事件均为 0。
8. 连接池耗尽在 750 ms 后以 `POOL_CONNECT_TIMEOUT` 超时，并可恢复；连接池关闭后拒绝新借用。

## 配置与边界

- 数据库密码已轮换，但密码本身不进入本档案。
- 私网数据库端点不支持 SSL，因此 CloudBase 运行配置使用 `TENCENT_PG_SSL_MODE=disable`；数据库未开放公网访问，连接仍受私有 VPC 边界保护。
- `USER_STORE_ADAPTER` 仍为 `sqlite`。003 只交付 PostgreSQL 连接、事务、就绪与隔离基础，不代表业务 UserStore 已切换到 PostgreSQL。
- 百炼密钥缺失警告只影响 `/api/chat`，不属于 003 验收范围。

## 已处理偏差

版本 009 的首次 003d 验证因会话变量名沿用旧约定而在用户 A 上下文检查处失败。代码随后统一为数据库辅助函数使用的 `app.current_user_id`，形成提交 `c8e2518` 并部署版本 010。首次失败发生在创建测试数据之前；版本 010 的完整成功验证又证明最终清理结果为 0。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```


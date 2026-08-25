# 005e LangGraph PostgreSQL 共享 Checkpointer 单实例云验收

验收日期：2026-08-25（Asia/Shanghai）

## 结论

005e 已在 CloudBase 046 完成单实例、三个独立 Node.js 进程的 PostgreSQL 共享 checkpointer 验证，并完成零残留清理。

- 本地云连接守卫：`PASS`
- 官方 PostgreSQL saver 版本：`1.0.4`
- seed 独立进程写入与持久化：`PASS`
- resume 独立进程恢复旧状态：`PASS`
- 不同服务端身份的同名 thread 隔离：`PASS`
- 原始身份与公开 thread 标识不落库：`PASS`
- cleanup：`PASS`
- cleanup 后数据行残留：`0`
- 业务 UserStore：继续保持 `sqlite`

## 已验证能力

1. seed 进程写入两步状态后，PostgreSQL 中存在可恢复的共享 checkpoint。
2. 不同进程的 resume 阶段能够读取 seed 状态并继续到 count 4。
3. 不同服务端身份使用相同公开 thread 值时无法读取对方状态。
4. 数据库中不保存原始身份或公开 thread 标识。
5. 重复 seed 被 `CP_SEED_PREEXISTING_STATE` 失败关闭，不覆盖既有验证状态。
6. 缺少显式云验证确认时，resume 和 cleanup 在联网前被拒绝。
7. cleanup 删除本次受控验证产生的数据，最终残留为零。

## 发布边界

- 本验收仅覆盖单实例共享 checkpointer，不覆盖双实例并发、故障转移或全量 PostgreSQL 切换。
- UserStore 在本次验证中保持 SQLite，没有迁移真实用户数据。
- 双实例验证仍由拓扑门禁禁止，必须另行设计并验收后才能开放。
- 验收档案不保存HMAC密钥、连接信息、原始身份、thread值、进程号或Pod标识。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

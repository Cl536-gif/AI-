# 005k 稳定 SQLite 应用回滚演练验收

验收日期：2026-08-26（Asia/Shanghai）

## 结论

005k 已完成固定 SQLite 回滚制品、本地失败关闭门禁、CloudBase 基线部署、受控 PostgreSQL HTTP 写入、应用回滚、数据库写入保留证明以及精确清理闭环。

- 固定回滚标签：`sqlite-rollback-005k-v3`
- 固定构建源摘要：`PASS`
- SQLite UserStore 与内存 checkpointer：`PASS`
- 基线 health / ready：`200 / 200`
- PostgreSQL 中间修订 HTTP writer：`PASS`
- 新 SQLite 修订回滚：`PASS`
- 基线与回滚修订不同：`PASS`
- 应用回滚后 PostgreSQL 写入仍保留：`PASS`
- PostgreSQL checkpointer 精确清理：`PASS`
- 固定测试用户及建议精确清理：`PASS`
- 清理后 preflight：`PASS`，固定身份计数 `0`
- 独立临时服务删除：`PASS`

## 已验证能力

1. 回滚制品只允许 SQLite UserStore 与内存 checkpointer，并拒绝携带 PostgreSQL 切换值。
2. Dockerfile 与两份 npm 清单以固定 SHA-256 摘要校验，源码漂移时失败关闭。
3. SQLite 环境的 `/api/ready` 不依赖 PostgreSQL；PostgreSQL 适配器仍执行严格数据库 readiness。
4. CloudBase 未提供 `K_REVISION` 时，可以从脱敏后的服务修订身份生成 SHA-256 指纹，不输出 Pod 名称。
5. PostgreSQL 中间修订成功完成固定测试身份解析和 HTTP 建议写入；随后应用回到新的 SQLite 修订且未连接或改写 PostgreSQL。
6. DMS 只读证明确认应用回滚后 PostgreSQL 写入仍存在，应用回滚不会隐式执行数据回滚。
7. checkpointer、固定测试身份、用户及建议均按固定测试范围精确清理，最终 preflight 证明零残留。
8. 独立临时服务已删除，生产服务未参与本次回滚演练。

## 发布边界

- 本验收证明稳定 SQLite 应用修订可以作为 PostgreSQL 灰度期间的应用回滚路径。
- 应用回滚与数据回滚明确分离；回到 SQLite 不会自动删除 PostgreSQL 写入。
- 本验收不授权全量 PostgreSQL 切换，也不证明生产数据迁移或数据库灾备恢复已经完成。
- 本轮 PostgreSQL HTTP 阶段只执行 writer，不把双实例 marker 作为本轮必需证据；双实例与并发能力由 005f、005g、005h 独立验收覆盖。
- 验收档案不保存域名、地址、账号、密码、连接串、token、Pod 名称、修订原值、身份标识或真实用户数据。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

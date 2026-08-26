# 005f LangGraph PostgreSQL 共享 Checkpointer 双实例云验收

验收日期：2026-08-26（Asia/Shanghai）

## 结论

005f 已在独立CloudBase临时服务完成两个真实Pod之间的共享PostgreSQL checkpointer顺序恢复验证，并完成数据库零残留清理和临时部署下线。

- 独立验证服务与正式服务隔离：`PASS`
- 正式Provider门禁保持关闭：`PASS`
- 实例A writer写入与持久化：`PASS`
- 实例B跨Pod恢复writer状态：`PASS`
- 两个实例确认为不同Pod：`PASS`
- 原始身份与公开thread标识不落库：`PASS`
- cleanup后数据行残留：`0`
- 临时生效部署删除：`PASS`
- 正式业务UserStore：继续保持`sqlite`

## 已验证能力

1. writer在实例A产生count 2并持久化共享checkpoint。
2. reader在实例B读取实例A状态并继续到count 4。
3. 验证器使用HMAC化实例指纹证明writer与reader来自两个不同Pod，但不输出或归档实例标识。
4. 原始身份、公开thread值和run标识不作为数据库thread键保存。
5. cleanup删除本轮checkpoint、blob和write数据，最终残留总数为0。
6. 临时服务唯一生效部署已删除，双Pod不再运行。

## 故障与修复

1. 首次部署因构建上下文未设置为`backend`，镜像构建找不到Dockerfile；修正构建目录后解决。
2. 临时服务误继承PostgreSQL runtime checkpointer配置，启动门禁按设计失败关闭；改为Memory运行时且仅验证脚本直连共享saver。
3. 临时服务未复制正式服务私网配置，readiness返回连接超时；修正VPC和子网后readiness通过。
4. 首次误在同一Pod的两个Shell运行reader。旧验证器先写入再判断实例相同，污染count；修复为在任何invoke前核对writer状态和实例指纹，同Pod拒绝不再产生写入。
5. 清理受污染测试轮次后，使用新轮次在两个真实Pod重新验证并通过。

## 发布边界

- 本验收只证明两个Pod之间的顺序状态恢复，不证明同一thread并发写冲突语义。
- 不覆盖滚动升级、故障转移、自动扩缩容、跨区域恢复或HMAC密钥轮换。
- 不授权UserStore PostgreSQL双实例运行或全量PostgreSQL切换。
- 正式`diet-secretary-api`未扩容、未切换Provider；临时服务运行时保持Memory checkpointer和SQLite UserStore。
- 验收档案不保存密钥、连接信息、域名、实例名、Pod标识、run ID、原始身份或thread值。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

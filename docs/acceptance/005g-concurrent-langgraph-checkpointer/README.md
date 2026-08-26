# 005g LangGraph PostgreSQL 同一 Thread 并发云验收

验收日期：2026-08-26（Asia/Shanghai）

## 结论

005g 已在独立CloudBase临时服务的两个真实Pod之间完成同一thread并发写入、幂等重放、完整checkpoint链和零残留验证，并完成临时部署下线。

- 独立验证服务与正式服务隔离：`PASS`
- 正式Provider门禁保持关闭：`PASS`
- 两个不同Pod真实重叠：`PASS`
- contender A/B状态演进：`2 → 4 → 6`
- B明确等待同一thread锁：`PASS`
- 两个固定操作各应用一次：`PASS`
- 固定操作重放不新增checkpoint：`PASS`
- checkpoint总数：`9`
- checkpoint父子链分支数：`0`
- 原始身份与公开thread标识不落库：`PASS`
- cleanup后数据行残留：`0`
- 临时生效部署删除且实例停止：`PASS`
- 正式业务UserStore：继续保持`sqlite`

## 已验证能力

1. 由内部HMAC thread作用域派生PostgreSQL advisory lock键，不把原始身份或公开thread值作为锁键保存。
2. 实例A持有同一thread锁期间，实例B确实进入等待；A写入后B读取更新后的状态再继续写入。
3. 两项固定操作各出现一次，最终count为6；不存在并发成功但丢失一次更新的情况。
4. 重放已应用操作时识别幂等状态，checkpoint ID保持不变。
5. 完整checkpoint集合包含9个节点，所有父节点存在且每个父节点最多一个子节点，分支数为0。
6. 验证器确认两个实例指纹不同，但不输出或归档实例标识。
7. cleanup删除本轮checkpoint、blob和write数据，最终残留总数为0。
8. 临时生效部署已删除，历史版本实例数量为0；正式服务未修改。

## 失败关闭证据

1. 缺少独立确认或双实例声明时，验证器在联网前拒绝运行。
2. contender B在A之前执行时，base-state门禁在写入前拒绝。
3. B未在A持锁期间启动时，overlap门禁拒绝把顺序执行冒充并发证据。
4. 两个Shell来自同一Pod时，实例集合门禁拒绝把同Pod双进程冒充双Pod验收。
5. 所有作废轮次均执行精确cleanup并证明零残留。

## 发布边界

- 本验收证明专用验证器中的同一thread双Pod并发可由advisory lock线性化。
- 本批没有把锁接入正式HTTP、正式LangGraph路由或正式Provider，不授权生产流量启用该路径。
- 不覆盖进程强杀、网络分区、锁公平性、长期任务取消、滚动升级、区域故障或HMAC密钥轮换。
- 不授权UserStore PostgreSQL双实例运行或全量PostgreSQL切换。
- 验收档案不保存密钥、连接信息、域名、实例名、Pod标识、run ID、进程号、原始身份或thread值。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

# 005f 双实例共享 LangGraph checkpointer 验证评审

状态：`LOCAL_GATED`。本批只建立独立验证服务方案、双实例证明和零残留清理，不放宽正式服务的checkpointer Provider门禁。

## 安全边界

1. 不在现有`diet-secretary-api`服务直接扩到双实例；创建独立验证服务，避免SQLite UserStore在真实业务流量下形成多副本不一致。
2. 验证服务保持`USER_STORE_ADAPTER=sqlite`，运行时`LANGGRAPH_CHECKPOINTER_BACKEND=memory`；只有专用脚本直接构造PostgreSQL saver。
3. 验证服务必须明确声明2个实例、固定最小和最大实例数均为2，并使用独立确认词。缺一项时脚本在联网前失败关闭。
4. 两个实例必须共享同一套数据库连接配置、schema版本和HMAC thread作用域密钥；密钥不得进入命令、截图、日志或验收归档。
5. 每轮使用新的非敏感run ID。writer发现旧状态时拒绝覆盖；reader找不到状态或实例指纹相同时拒绝通过。
6. 实例指纹由HMAC密钥和Pod hostname生成；输出只报告“两实例不同”的布尔结论，不输出hostname或指纹。
7. cleanup无论reader成功或失败都必须运行，并证明checkpoints、blobs、writes总残留为0。

## 验证流程

1. 提交并部署本批脚本到一个新的专用验证服务，不复用正式`diet-secretary-api`。
2. 专用服务配置两个常驻实例；确认实例列表中同时出现两个Running实例。
3. 在实例A Webshell运行writer；预期`PASS`、count 2、persisted true、rawIdentifiersStored false。
4. 在实例B Webshell运行reader；预期`PASS`、count 4、writerStateLoaded true、distinctInstances true、instanceCount 2。
5. 在任一实例运行cleanup；预期`PASS`、remainingRows 0。
6. 删除或缩容专用验证服务，避免持续成本；不得把005f变量复制到正式服务。

## 本批不证明

- 同一thread并发写冲突的业务合并语义。
- 滚动升级期间旧新代码的序列化兼容。
- HMAC密钥轮换和历史thread迁移。
- UserStore PostgreSQL双实例运行或全量切换。
- 自动扩缩容、故障转移和区域级恢复。

## 退出标准

- writer与reader来自不同实例且跨实例恢复成功。
- 不同身份不可读取状态，原始标识未落库。
- cleanup残留为0。
- 专用验证服务已停止或删除。
- 证据归档不含密钥、连接信息、hostname、Pod标识或测试thread值。

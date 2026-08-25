# 005e 共享 LangGraph checkpointer 第一批评审

状态：`GATED`。第一批已建立选择器和失败关闭边界；第二批固定官方包目标、运行时适配器、身份作用域和DMS迁移设计。当前仍不安装依赖、不执行共享状态迁移、不改变SQLite线上路径。

## 已落地边界

1. `USER_STORE_ADAPTER` 默认为 SQLite 时，继续使用 `MemorySaver`，保持现有行为。
2. Tencent PostgreSQL 单实例灰度只有在实例上限 1、连接池上限 1、确认词正确时，才允许临时使用 `MemorySaver`。
3. 非法灰度配置继续复用 005a 门禁并失败关闭。
4. `LANGGRAPH_CHECKPOINTER_BACKEND=postgres` 已保留显式选择位，但在真正的共享 saver 安装、初始化和迁移完成前拒绝启动。
5. 不允许通过配置一个未知 backend 静默回退到内存。

## 第二批固定设计

1. 官方依赖固定为`@langchain/langgraph-checkpoint-postgres@1.0.4`。当前LangGraph 1.4.8使用checkpoint基础包1.1.3；1.0.4的peer范围兼容现有树，避免采用要求基础包至少1.1.4的1.0.5而顺带升级核心依赖。
2. `PostgresSaver`使用构造函数接收现有`pg.Pool`，schema固定为`langgraph_checkpoint`；不使用连接串创建第二个池。
3. 应用运行时禁止调用`saver.setup()`。建表与版本记录必须由DMS迁移使用所有者权限完成，`diet_app`只获得运行所需DML权限。
4. 数据库内部`thread_id`不直接使用客户端值，而是对“版本、服务端身份、公开threadId”执行HMAC-SHA256。相同身份可跨实例续接，不同身份即使提交相同公开threadId也映射到不同内部键。
5. HMAC密钥必须独立于数据库和模型密钥，长度至少32；不得记录进日志、验收归档或仓库。
6. 启用共享backend还必须同时给出固定非秘密确认词和schema版本`1.0.4`；缺失或不匹配时在启动阶段失败关闭。
7. 当前`package.json`与锁文件含其他未归档修改，本批不触碰它们；依赖安装必须在能精确分离提交时完成。

## 为什么本批不直接安装 PostgreSQL saver

- 当前 `package.json` 和锁文件含有用户尚未归档的其他修改，本批避免扩大重叠范围。
- 共享 saver 需要独立确认包版本、连接池所有权、初始化迁移、序列化兼容、清理策略和优雅关闭，不能只添加依赖便宣称完成。
- 生产切换还需要跨重启与双实例验证；当前 `productionReady` 明确保持 false。

## 下一批退出标准

1. 在不混入Supabase草稿的前提下安装并锁定官方PostgreSQL saver 1.0.4。
2. 评审并执行独立DMS迁移，验证所有者、PUBLIC撤权、`diet_app`最小DML权限和迁移版本。
3. 为相同公开`thread_id`验证：同一身份实例A写入、实例B续接、滚动重启后续接；不同身份不得读取。
4. 验证HMAC密钥轮换策略；未设计迁移前不得直接替换密钥导致所有活跃thread失联。
5. 验证并发同 thread 的顺序、失败重放、过期/删除和无跨用户读取。
6. 完成上述证据前，`LANGGRAPH_CHECKPOINTER_BACKEND=postgres` 必须继续失败关闭。

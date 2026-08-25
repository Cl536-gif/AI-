# 005e 共享 LangGraph checkpointer 第一批评审

状态：`GATED`。本批只建立选择器和失败关闭边界，不创建共享状态表，不安装新依赖，不改变当前 SQLite 线上路径。

## 已落地边界

1. `USER_STORE_ADAPTER` 默认为 SQLite 时，继续使用 `MemorySaver`，保持现有行为。
2. Tencent PostgreSQL 单实例灰度只有在实例上限 1、连接池上限 1、确认词正确时，才允许临时使用 `MemorySaver`。
3. 非法灰度配置继续复用 005a 门禁并失败关闭。
4. `LANGGRAPH_CHECKPOINTER_BACKEND=postgres` 已保留显式选择位，但在真正的共享 saver 安装、初始化和迁移完成前拒绝启动。
5. 不允许通过配置一个未知 backend 静默回退到内存。

## 为什么本批不直接安装 PostgreSQL saver

- 当前 `package.json` 和锁文件含有用户尚未归档的其他修改，本批避免扩大重叠范围。
- 共享 saver 需要独立确认包版本、连接池所有权、初始化迁移、序列化兼容、清理策略和优雅关闭，不能只添加依赖便宣称完成。
- 生产切换还需要跨重启与双实例验证；当前 `productionReady` 明确保持 false。

## 下一批退出标准

1. 选定与 `@langchain/langgraph@1.4.8` 兼容的官方 PostgreSQL saver，并锁定版本。
2. 复用受控 PostgreSQL 连接配置，但明确 saver 是否拥有独立池及其连接预算。
3. 提供幂等 schema 初始化流程，应用运行角色不得在每次启动时任意改 schema。
4. 为相同 `thread_id` 验证：实例 A 写入、实例 B 续接、滚动重启后续接。
5. 验证并发同 thread 的顺序、失败重放、过期/删除和无跨用户读取。
6. 完成上述证据前，`LANGGRAPH_CHECKPOINTER_BACKEND=postgres` 必须继续失败关闭。

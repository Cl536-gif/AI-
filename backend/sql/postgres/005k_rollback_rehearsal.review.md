# 005k 稳定SQLite回滚制品与滚动回滚演练评审

评审日期：2026-08-26（Asia/Shanghai）

状态：`CANDIDATE`。本批固定回滚源码标签、构建输入摘要和非敏感环境快照；不开放PostgreSQL full模式。

## 稳定制品

- 固定标签：`sqlite-rollback-005k-v1`；标签必须指向包含005k校验器的已推送提交。
- 构建上下文：`backend`；Dockerfile、`package.json`和`package-lock.json`必须与制品中的SHA-256一致。
- 稳定运行配置：`USER_STORE_ADAPTER=sqlite`、`LANGGRAPH_CHECKPOINTER_BACKEND=memory`、`NODE_ENV=production`、`PORT=3001`。
- PostgreSQL切换模式、切换确认及PostgreSQL checkpointer确认/模式在回滚修订中必须为空。
- 制品不保存API Key、数据库密码、连接地址、HMAC密钥或HTTP灰度token。

## 演练顺序

1. 从固定标签部署独立临时服务的SQLite基线修订，运行`baseline`，记录经过HMAC不可逆化的修订指纹和两个健康检查结果。
2. 在同一临时服务部署已验证的PostgreSQL HTTP灰度修订；只使用固定测试身份并证明目标产生预期写入。
3. 冻结测试写入，把流量滚动切换到由同一固定标签重新构建的SQLite回滚修订。
4. 在回滚修订运行`rollback`；构建摘要、SQLite环境、`/api/health`和`/api/ready`必须全部PASS，且修订指纹必须不同于基线。
5. DMS只读证明PostgreSQL灰度写入在应用回滚后仍存在；应用回滚不得自动删除、复制或改写PostgreSQL数据。
6. 使用该灰度批次自己的清理脚本删除固定测试数据，再由DMS证明业务表和checkpointer残留为0。
7. 删除独立临时服务；正式服务和full门禁保持不变。

## 数据边界

- 应用回滚不是数据库回滚。PostgreSQL已提交写入继续是权威记录，不自动复制回SQLite。
- 有真实流量时必须先冻结写入再回滚；否则SQLite和PostgreSQL会形成不可自动合并的分叉。
- 本轮只能使用固定测试身份；清理之前不得恢复新的测试写入。
- 当前005j为空库启动决定不等于授权丢弃未来PostgreSQL真实写入。

## 失败关闭条件

- 固定标签不存在、被移动，或任一构建输入摘要不匹配；
- 回滚环境不是SQLite加memory，或残留任何切换激活值；
- 基线和回滚没有来自不同CloudBase修订的不可逆指纹；
- 任一健康检查不是200；
- 回滚过程删除、覆盖或复制PostgreSQL数据；
- 固定测试数据及checkpointer无法证明零残留；
- 临时服务未下线或正式服务配置发生变化。

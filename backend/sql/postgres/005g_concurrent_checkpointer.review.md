# 005g 同一thread并发、冲突与失败重放评审

状态：`LOCAL_GATED`。本批只建立专用并发验证器和PostgreSQL advisory lock原语，不接入正式请求路径，不放宽正式Provider。

本地验证：锁成功/轮询/超时/释放失败、固定操作重放、线性链与分支拒绝、MemorySaver端到端六阶段模拟均已通过；005f、Provider门禁、005d切换审计和004p HTTP异步边界回归通过。云端双Pod重叠验证尚未执行，因此本批仍为候选而非完成。

## 官方saver并发结论

1. PostgreSQL saver以`thread_id + namespace + checkpoint_id`作为checkpoint唯一键。
2. `put()`保存调用方传入的父checkpoint ID，但没有约束同一父checkpoint只能有一个子节点。
3. 两个实例同时从相同latest checkpoint继续时，可以各自产生不同checkpoint ID并形成兄弟分支；两个请求都成功不代表业务状态线性一致。
4. `getTuple()`在未指定checkpoint ID时按ID降序取最新分支，因此未被选中的分支虽然仍在数据库，业务上可能表现为一次更新丢失。
5. 005g验收必须证明父子链无分支，不能只检查最终latest值。

## 设计边界

1. 使用由内部HMAC thread键派生的两个32位有符号整数作为PostgreSQL session advisory lock键；不把原始身份或公开thread值传入锁。
2. 锁客户端在整个graph invoke期间保持连接；同一进程的saver至少需要第二条连接，因此每实例验证池固定为2。
3. 使用`pg_try_advisory_lock`轮询，超时失败关闭；finally必须显式unlock，unlock失败销毁连接。
4. 专用双实例服务继续保持SQLite UserStore和Memory runtime checkpointer，只有验证脚本直连共享saver。
5. contender A先获得锁并短暂持有；contender B必须观察到明确等待，随后读取A的新状态再写入，从而证明发生真实重叠但写入被串行化。
6. 两个操作各带固定幂等标识；重放A必须识别已应用并保持checkpoint ID不变。
7. verify必须得到count 6、两个操作各一次、两个实例不同、父子链零分支。
8. 任一步失败都必须cleanup，最终残留为0；测试服务完成后删除生效部署。

## 云端顺序草案

1. 新建或复用无生效版本的独立验证服务，部署两个常驻Pod；不得修改正式`diet-secretary-api`。
2. 在任一Pod运行seed，预期count 2。
3. 在Pod A启动contender-a；它持锁10秒。立即在Pod B启动contender-b。
4. A预期count 4；B必须证明等待过A的锁并得到count 6。
5. 运行replay-a，预期replayed true且checkpointUnchanged true。
6. 运行verify，预期operationsApplied 2、distinctInstances true、branchCount 0。
7. 运行cleanup，预期remainingRows 0；随后删除临时生效部署。

## 本批不证明

- advisory lock已接入正式HTTP或所有LangGraph入口。
- 连接池总预算、实例上限和数据库连接上限适合正式流量。
- 进程被强杀、网络分区或数据库故障时的端到端恢复。
- 长时间任务的锁超时、取消、可观测性和公平性。
- HMAC密钥轮换、跨版本序列化兼容和区域级灾备。

## 退出标准

- 本地锁生命周期、超时、释放失败和分支检测测试通过。
- 云端两个Pod真实重叠，写入线性化且无checkpoint分支。
- 幂等重放不新增checkpoint。
- cleanup残留为0，临时生效部署已删除。

# 005 PostgreSQL 单实例灰度门禁与回滚沙箱验收

验收日期：2026-08-25（Asia/Shanghai）

## 结论

005a–005b 已完成启动门禁、SQLite稳定路径回归、真实PostgreSQL单实例关键读写回滚沙箱和恢复SQLite验证。

- 单实例灰度启动门禁：`PASS`
- SQLite默认Provider与业务回归：`PASS`
- PostgreSQL 37方法适配器契约：`PASS`
- PostgreSQL数据库身份与readiness：`PASS`
- 用户、活动设置、档案和建议关键读写：`PASS`
- 最终事务回滚及零残留：`PASS`
- 恢复SQLite稳定版本及健康检查：`PASS`
- 全量PostgreSQL切换：仍为失败关闭

## 已验证边界

1. 仅配置`USER_STORE_ADAPTER=tencent-postgres`不足以启动PostgreSQL Provider。
2. 首次灰度必须显式声明单实例模式、固定非秘密确认词、实例上限1和连接池上限1。
3. 缺少确认、危险实例/连接池范围、未知模式和未就绪的全量模式均被拒绝。
4. SQLite稳定版本的Provider、应用串行写入、LangGraph异步身份、health和数据库ready不受门禁影响。
5. PostgreSQL灰度修订在单实例、池上限1条件下完成7项检查并最终回滚。
6. 新事务确认沙箱用户、档案和建议记录均为0。
7. 灰度后恢复SQLite稳定版本，适配器和健康检查均符合预期。

## 发布边界

- 本次没有发送真实聊天流量，没有迁移真实用户数据。
- 本次不启用双写，不放宽数据库权限，不修改表结构。
- 本次通过不代表全量切换通过；`isTencentPostgresCutoverReady()`继续返回false。
- 后续真实HTTP持久化灰度必须先具备受控测试身份和可验证清理方案。
- 归档不保存密码、连接地址、设备值、会话ID、Pod标识或真实用户信息。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

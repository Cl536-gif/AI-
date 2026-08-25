# 004n Provider 与异步调用边界云端验收

验收日期：2026-08-25（Asia/Shanghai）

## 结论

004n Provider 与正式异步调用边界已在 CloudBase 版本028完成默认SQLite配置下的包内回归和公开健康检查。

- Provider选择回归：`PASS`
- 聊天活动异步等待回归：`PASS`
- 首页隐私问候回归：`PASS`
- 公开健康端点：`PASS`
- CloudBase版本030真实百炼聊天：HTTP 200 `PASS`
- 线上业务存储适配器：仍为 `sqlite`

## 已验证能力

1. SQLite仍为默认UserStore适配器。
2. 只有显式配置时才可选择Tencent PostgreSQL适配器。
3. 未知适配器继续失败关闭。
4. 显式选择的两种Store均满足37方法生产契约。
5. 首页问候和普通聊天在继续处理前等待活动记录完成。
6. 账号合并服务按调用时从统一Provider取得Store。
7. CloudBase版本028服务启动成功且公开健康端点返回正常。
8. CloudBase版本030修正误填的API Key后，真实`/api/chat`请求返回HTTP 200及有效回复和会话标识。

## 警告说明

- Node.js输出的SQLite ExperimentalWarning属于运行时功能状态提示，不代表测试失败。
- 百炼环境变量警告只影响真正调用模型的聊天请求；本批包内回归不调用模型，三项测试均明确返回PASS。
- 版本029首次真实聊天因误填API Key返回`Invalid API-key provided`；变量存在性和格式检查正常。更正Key并部署版本030后验证通过。

## 发布边界

- 本批不修改数据库结构。
- 本批未把线上`USER_STORE_ADAPTER`切换为`tencent-postgres`。
- 验收证据不保存API Key、应用ID具体值或真实会话标识。
- 尚未提交的身份和LangGraph路由异步兼容改动不属于本批。
- 真实单实例PostgreSQL灰度仍需后续HTTP端到端回归与回滚方案。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```

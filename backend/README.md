# 专属饮食秘书 · 后端中间层

对应需求文档《专属饮食秘书_最简后端需求文档.md》中的第二、三点：

- **后端中间层**：接收前端消息，转发给阿里云百炼应用，把回复转发回前端。
- **密钥安全存储**：百炼 API Key / 应用 ID / 接口地址只存在于服务端环境变量中，不出现在前端代码或提交到仓库。

其余部分（聊天前端页面、用户身份与上次活跃时间记录、回复内容安全检查）尚未实现，会在后续阶段补上。

## 目录结构

```
backend/
├── src/
│   ├── server.js              # Express 入口，挂载路由、CORS、错误处理
│   ├── config.js              # 读取并校验环境变量
│   ├── routes/chat.js         # POST /api/chat
│   └── services/bailianClient.js  # 封装对阿里云百炼应用完成接口的调用
├── .env.example                # 环境变量模板（不含真实密钥）
└── package.json
```

## 快速开始

```bash
cd backend
npm install
cp .env.example .env
# 编辑 .env，填入真实的 BAILIAN_API_KEY / BAILIAN_APP_ID
npm start
```

默认监听 `http://localhost:3001`。

## 环境变量

| 变量名 | 说明 |
| --- | --- |
| `PORT` | 服务监听端口，默认 3001 |
| `CORS_ORIGIN` | 允许跨域访问的前端地址，逗号分隔；留空则放行所有来源（仅建议 demo 阶段） |
| `BAILIAN_API_KEY` | 阿里云百炼 API Key（**必填，不要提交到仓库**） |
| `BAILIAN_APP_ID` | 百炼应用 ID / 知识库 ID（**必填**） |
| `BAILIAN_BASE_URL` | 百炼应用调用的基础地址，默认 `https://dashscope.aliyuncs.com/api/v1/apps`，一般不需要修改 |

`.env` 已加入 `.gitignore`，不会被提交；仓库中只保留 `.env.example` 模板。

## 接口说明

### `POST /api/chat`

请求体：

```json
{
  "message": "你好",
  "sessionId": "可选，上一轮返回的 sessionId，用于保持多轮上下文"
}
```

响应：

```json
{
  "reply": "AI 秘书的回复文本",
  "sessionId": "本轮会话 id，下一次请求带上即可继续同一段对话"
}
```

多轮对话的上下文由百炼一侧通过 `session_id` 维护，后端只做透传，不在本地保存对话内容。

### `GET /api/health`

健康检查，返回 `{ "status": "ok" }`，用于确认服务已启动。

## 手动测试

未配置真实密钥前，可以确认服务基本可用：

```bash
curl http://localhost:3001/api/health
# {"status":"ok"}

curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好"}'
# 未配置密钥时会返回 500 + 明确的报错信息，属预期行为
```

配置好 `.env` 中的真实密钥后，同样的请求应返回百炼应用的实际回复。

# 专属饮食秘书 · 后端 + 前端 Demo

对应需求文档《专属饮食秘书_最简后端需求文档.md》核心功能清单：

- [x] 1. 对话页面（前端）—— `public/`，纯静态页面，由本服务直接托管
- [x] 2. 后端中间层服务 —— `src/routes/chat.js` + `src/services/bailianClient.js`
- [x] 3. 密钥安全存储 —— 密钥只存在于服务端 `.env`，不出现在前端代码或提交到仓库
- [x] 4. 简易用户身份 + "上次活跃时间"记录 —— `src/services/userStore.js`（SQLite）
- [x] 5. 回复内容安全检查 —— `src/services/contentSafety.js`

## 目录结构

```
backend/
├── public/                      # 前端：聊天页面（静态文件，由 Express 直接托管）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/
│   ├── server.js                 # Express 入口：CORS、静态资源、路由、错误处理
│   ├── config.js                 # 读取并校验环境变量
│   ├── routes/chat.js            # POST /api/chat, POST /api/chat/greeting
│   └── services/
│       ├── bailianClient.js      # 封装对阿里云百炼应用完成接口的调用
│       ├── chatService.js        # 编排：调用百炼 + 用户活跃记录 + 内容安全检查
│       ├── userStore.js          # SQLite：记录每个用户最后一次活跃时间
│       └── contentSafety.js      # 回复文本英文字母检测 / 替换
├── data/                          # SQLite 数据文件（运行时自动创建，已 gitignore）
├── .env.example                   # 环境变量模板（不含真实密钥）
└── package.json
```

## 快速开始

```bash
cd backend
npm install
cp .env.example .env
# 编辑 .env，填入真实的 BAILIAN_API_KEY / BAILIAN_APP_ID / BAILIAN_BASE_URL
npm start
```

浏览器打开 `http://localhost:3001` 即可看到聊天界面（前端和后端是同一个服务，一个链接搞定）。

## 环境变量

| 变量名 | 说明 |
| --- | --- |
| `PORT` | 服务监听端口，默认 3001 |
| `CORS_ORIGIN` | 允许跨域访问的前端地址，逗号分隔；留空则放行所有来源（仅建议 demo 阶段） |
| `BAILIAN_API_KEY` | 阿里云百炼 API Key（**必填，不要提交到仓库**） |
| `BAILIAN_APP_ID` | 百炼应用 ID / 知识库 ID（**必填**） |
| `BAILIAN_BASE_URL` | 百炼应用调用的基础地址（DashScope 原生格式的根路径 + `/apps`），一般不需要修改 |
| `INACTIVITY_THRESHOLD_DAYS` | 用户超过多少天没来对话，就在开场白里提示 AI 体现"很久没聊"这件事，默认 3 |

`.env` 已加入 `.gitignore`，不会被提交；仓库中只保留 `.env.example` 模板。`data/` 目录（SQLite 数据库文件）同样已 gitignore。

## 接口说明

### `POST /api/chat/greeting`

前端页面加载时调用一次，让 AI 秘书结合"距离上次活跃过了多久"主动开场问候。

请求体：`{ "userId": "浏览器生成的匿名用户标识" }`

响应：`{ "reply": "...", "sessionId": "..." }`

### `POST /api/chat`

请求体：

```json
{
  "userId": "浏览器生成的匿名用户标识",
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

多轮对话上下文由百炼一侧通过 `session_id` 维护，后端不在本地保存对话内容，只保存"用户标识 + 最后活跃时间"这一条记录（`data/app.db`）。

### `GET /api/health`

健康检查，返回 `{ "status": "ok" }`。

## 用户身份与上次活跃时间

- 前端首次打开页面时，用 `crypto.randomUUID()` 生成一个匿名 `userId`，存进 `localStorage`（`dietSecretary.userId`），之后每次请求都带上。
- 后端用内置的 `node:sqlite`（Node 22.5+ 自带，无需额外安装原生依赖）在 `data/app.db` 里记一张 `users` 表：`user_id` + `last_active_at`。
- 每次调用 `/api/chat/greeting`（页面打开时）都会先查一下这个用户上次的 `last_active_at`，再更新为当前时间。如果间隔 ≥ `INACTIVITY_THRESHOLD_DAYS` 天，会把"已经 N 天没来"这个信息拼进给百炼的提示词里，让 AI 自然地在开场白里体现，而不是用固定模板句子。

## 回复内容安全检查

`contentSafety.js` 用正则 `/[A-Za-z]{2,}/` 检测回复里连续两个及以上的英文字母，"AI秘书"这个固定身份词除外。`chatService.js` 里的流程是：

1. 调用百炼，检查回复
2. 若检测到违规英文，重新生成一次
3. 重新生成后仍违规，就做替换处理（把违规片段直接去掉）作为兜底

## 手动测试

未配置真实密钥前，可以确认服务基本可用（预期会在调用百炼那一步报错，但前面的校验、页面、数据库部分应该都正常）：

```bash
curl http://localhost:3001/api/health
# {"status":"ok"}

curl -X POST http://localhost:3001/api/chat/greeting \
  -H "Content-Type: application/json" \
  -d '{"userId":"test-user-1"}'
```

配置好 `.env` 中的真实密钥、且网络能访问阿里云域名后，浏览器打开 `http://localhost:3001` 直接体验完整聊天效果。

> 注意：如果你是在 Claude Code 云端沙箱环境里运行，出站网络可能被组织策略限制访问阿里云域名（`*.aliyuncs.com`），届时需要在本地或有公网访问权限的服务器上验证真实对话效果。

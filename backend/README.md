# 专属饮食秘书 · 后端 + 前端 Demo

对应需求文档《专属饮食秘书_最简后端需求文档.md》核心功能清单：

- [x] 1. 对话页面（前端）—— `public/`，纯静态页面，由本服务直接托管
- [x] 2. 后端中间层服务 —— `src/routes/chat.js` + `src/services/bailianClient.js`
- [x] 3. 密钥安全存储 —— 密钥只存在于服务端 `.env`，不出现在前端代码或提交到仓库
- [x] 4. 简易用户身份 + "上次活跃时间"记录 —— `src/services/userStore.js`（SQLite）
- [x] 5. 回复内容安全检查 —— `src/services/contentSafety.js`
- [x] 6. 独立的本地知识库问答链路（对比测试用）—— `src/routes/chatLocal.js` + `src/services/localChatService.js`，跟第 2 条完全分开，互不影响

## 目录结构

```
backend/
├── public/                      # 前端：聊天页面（静态文件，由 Express 直接托管）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── compare.html              # 独立的对比测试页面，跟主聊天页面互不影响
├── src/
│   ├── server.js                 # Express 入口：CORS、静态资源、路由、错误处理
│   ├── config.js                 # 读取并校验环境变量
│   ├── routes/
│   │   ├── chat.js               # POST /api/chat, POST /api/chat/greeting（百炼 App 自带知识库）
│   │   └── chatLocal.js           # POST /api/chat-local（本地知识库，仅供对比测试）
│   └── services/
│       ├── bailianClient.js      # 封装对阿里云百炼应用完成接口的调用
│       ├── bailianGenericClient.js # 封装百炼"通用模型对话接口"调用，供本地知识库链路使用
│       ├── chatService.js        # 编排：调用百炼 + 用户活跃记录 + 内容安全检查
│       ├── localKbBridge.js      # 桥接 local-kb-tool 的检索逻辑（跨项目直接 require，不重复实现）
│       ├── localChatService.js   # 编排：本地检索 + 拼提示词 + 调用通用模型接口
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
| `BAILIAN_GENERIC_BASE_URL` | 本地知识库链路用的百炼通用模型接口地址，默认 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `BAILIAN_GENERIC_MODEL` | 本地知识库链路用的模型名，默认 `qwen-plus` |
| `LOCAL_KB_NAMES` | `/api/chat-local` 要同时查询的本地知识库名字，逗号分隔，默认 `diet,body-composition` |

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

### `POST /api/chat-local`（独立链路，仅供对比测试）

跟上面的 `/api/chat` 是两条完全独立的路径，互不影响：不调用百炼 App 自带的知识库，而是先在本地检索 `local-kb-tool` 的 `diet` 和 `body-composition` 两个知识库，把检索到的片段拼进提示词，再调用百炼"通用模型对话接口"（`qwen-plus`）生成回答。

请求体：

```json
{ "message": "减脂期间蛋白质应该吃多少" }
```

响应：

```json
{
  "reply": "AI 的回复文本",
  "retrieved": [
    {
      "kbName": "diet",
      "error": null,
      "chunks": [
        { "text": "检索到的原文片段", "source": "xxx.docx", "hybridScore": 0.82, "semanticScore": 0.79, "keywordScore": 0.9 }
      ]
    },
    { "kbName": "body-composition", "error": null, "chunks": [ /* ... */ ] }
  ]
}
```

`retrieved` 字段把两个知识库各自检索到的片段和打分都带回来了，方便直接判断"本地知识库这次到底命中了什么"，不用再单独跑 `local-kb-tool` 的 `npm run query` 去核对。

**部署依赖**：这条链路直接 `require` 引用 `local-kb-tool/src/query.js`（跨项目共用同一份检索逻辑，没有复制粘贴）。正式 CloudBase 构建使用仓库根目录作为构建上下文，由根目录 `Dockerfile` 只复制检索所需的五个运行时模块和 `diet`/`body-composition` 两个预构建索引；不会复制原始 `.docx`、评测报告或 `local-kb-tool/node_modules`。`vectra` 和 `@xenova/transformers` 作为后端运行依赖安装在 `/app/node_modules`，满足 Node 的父目录模块解析规则；镜像保留 `/app/backend/src` 的目录层级，以保证对 `local-kb-tool` 的相对路径引用正确。

本地重建索引仍可在 `local-kb-tool` 目录执行 `npm run build-index -- --kb diet` 和 `--kb body-composition`；某个知识库索引不存在时，这条链路不会报错崩溃，只是该知识库的 `chunks` 为空、`error` 字段会说明原因。

### 对比测试页面

浏览器打开 `http://localhost:3001/compare.html`，输入同一个问题，会同时调用 `/api/chat` 和 `/api/chat-local`，两栏并排显示回复内容；本地知识库那一栏还能展开看到具体检索到了哪些片段、打分多少，方便逐条对比命中率和回答质量。这个页面完全独立于 `index.html` 主聊天界面，不会互相干扰。

### 已知限制：`/api/chat-local` 在长连续多轮场景下的对话流程不够可靠

真实多轮测试（比如：场景 → 打饭方式 → 口味 → ……一路连续问下去）发现，`/api/chat-local` 有两类具体问题，而百炼 App 那边（`/api/chat`）在完全相同的输入序列下没有出现：

1. **提前出方案**：六项信息（场景、口味、预算、忌口、身材目标、是否运动）往往只收集到 2-3 项（比如刚问完场景和口味），模型就直接跳出具体菜品搭配方案了，没有走完系统提示词第 1-3 条要求的完整采集流程。
2. **无视新信息、重复提问**：用户在中途给出新信息（甚至是修正之前的答案）时，模型有时会完全忽略，继续重复问上一轮已经问过、用词几乎一样的问题，卡在原地推进不下去。

**根因判断**：不是知识库检索命中率的问题（检索到的片段跟当前话题是对得上的），是**系统提示词已经堆到 30 条规则，模型对"六项信息现在收集到哪一步了"这件事的判断，完全依赖自己在大段自然语言历史里回忆推断，没有任何结构化状态在跟踪**——规则数量本身在这个复杂度下已经开始出现执行力下降，再加规则去堵具体漏洞的边际收益已经明显递减。百炼 App 那边表现更稳，可能是因为它后台本身有独立于提示词之外的对话状态管理机制，不是靠同样纯提示词的方式做到的。

**决定（2026-07 记录）**：暂不投入"在代码里显式追踪六项信息收集状态、每轮把已收集/未收集清单显式喂给模型"这类结构性改造（工作量不小，还没确定 `/api/chat` 和 `/api/chat-local` 哪条链路会成为正式通道，值不值得投入取决于最终选型）。当前先把这个限制记录下来：

- 测试时避开需要长连续多轮走完整个信息采集流程的场景，容易踩到上面两个问题。
- 重点测试语气、格式、知识库内容准确性这几个不依赖复杂状态追踪的维度。
- 如果之后确定要用 `/api/chat-local` 做正式通道、且这两个问题依然存在，再回来做结构化状态追踪的改造。

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

# 本地知识库交叉验证工具

对应《本地知识库交叉验证工具·需求文档》核心功能清单的第 1、2 部分（第 3 部分"跟百炼结果对比"暂不实现）：

- [x] 1. 文档读取与处理 —— 读取 `.docx`、按段落切分、本地 embedding 向量化
- [x] 2. 本地向量存储与检索 —— 存进本地向量索引，按问题检索最相关的片段（附来源文档名）
- [ ] 3. 与百炼结果对比 —— 未实现，后续需要时再做

全程可以完全离线运行（只有第一次生成向量时需要联网下载一次本地 embedding 模型）。

## 关于"本地向量库"的一点说明

需求文档里提到用 Chroma，但 Chroma 的 JS 客户端本质是一个 HTTP 客户端，真正的存储引擎是一个独立的 Chroma 服务进程，目前只能通过 Python（`pip install chromadb` + `chroma run`）或 Docker 启动，没有纯 Node.js 内嵌版本。

这里改用 **[vectra](https://github.com/Stevenic/vectra)** —— 一个纯 Node.js 实现的轻量级本地向量库，数据直接存在本地文件夹里，不需要启动任何额外的服务进程，跟 `backend/` 项目的技术栈保持一致。检索效果（余弦相似度 + top-K）跟 Chroma 是一样的，只是不叫这个名字。

## 目录结构

```
local-kb-tool/
├── kb-docs/                # 放你的 .docx 知识库文件（已 gitignore，不提交原文）
│   └── .gitkeep
├── data/                    # 本地向量索引存储目录（运行 build-index 后自动生成，已 gitignore）
├── src/
│   ├── docReader.js         # 读取 .docx，用 mammoth 提取纯文本
│   ├── chunker.js           # 按段落切分成小片段
│   ├── embedder.js          # 用 @xenova/transformers 做本地 embedding
│   ├── vectorStore.js       # 封装 vectra：建索引 / 存 / 查
│   ├── buildIndex.js        # npm run build-index 的入口
│   └── query.js             # npm run query 的入口
├── .env.example
└── package.json
```

## 快速开始

```bash
cd local-kb-tool
npm install

# 把你的 8 份 .docx 知识库文件放进 kb-docs/ 目录

npm run build-index
# 首次运行会从 Hugging Face 下载一次本地 embedding 模型（几十 MB），之后完全离线

npm run query -- "需要注册吗"
npm run query -- "怎么瘦肚子"
```

> 用 `npm run query` 时问题参数前要加 `--`（`npm run query -- "问题"`），否则 npm 不会把参数透传给脚本。

## 配置项（可选，复制 `.env.example` 为 `.env` 后修改）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `KB_DOCS_DIR` | `./kb-docs` | 知识库 `.docx` 文件所在目录 |
| `KB_INDEX_DIR` | `./data/index` | 本地向量索引存储目录 |
| `KB_CHUNK_CHARS` | `500` | 每个片段的最大字符数（按段落切分，不会切碎单个段落，超长段落才会硬切） |
| `KB_TOP_K` | `5` | 查询时返回的最相关片段数量 |
| `KB_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | 本地 embedding 模型，需是 transformers.js 支持的模型 |

## 已验证的部分

在开发环境里已经验证过（用程序生成的示例 `.docx` 测试文件）：

- `.docx` 读取 + 按段落切分逻辑正确，中文段落、超长段落硬切都符合预期
- 向量存储/检索链路（写入、按相似度排序返回、附带来源文档名和片段序号）正确

**没有验证过的部分**：真实的 `@xenova/transformers` embedding 生成。这个开发环境的出站网络策略挡住了 Hugging Face（下载模型）和一个 npm 依赖 `sharp` 的安装源（GitHub Releases），所以 `npm run build-index` 在这里跑不通，报错发生在生成向量那一步，不是文档读取或存储这两块的问题。这两处都是网络访问限制，不是代码逻辑问题——在正常联网的本地环境里 `npm install` 应该能顺利装好 `sharp`（它是一个很成熟的包，各平台都有预编译包），`npm run build-index` 首次运行下载模型后也能正常生成向量。

请你在本地跑通 `npm install && npm run build-index && npm run query -- "需要注册吗"` 验证一下真实效果；如果报错，把报错信息发给我，我再针对性排查。

## 后续（第 3 部分，暂不做）

跟百炼检索结果并排对比的命令行交互，等你需要的时候再单独提出来做。

# 本地知识库交叉验证工具

对应《本地知识库交叉验证工具·需求文档》核心功能清单的第 1、2 部分（第 3 部分"跟百炼结果对比"暂不实现）：

- [x] 1. 文档读取与处理 —— 读取 `.docx`、按段落切分、本地 embedding 向量化
- [x] 2. 本地向量存储与检索 —— 存进本地向量索引，按问题检索最相关的片段（附来源文档名）
- [ ] 3. 与百炼结果对比 —— 未实现，后续需要时再做
- [x] 4. 检索效果批量测试 —— `src/genTestQuestions.js` + `src/evalRetrieval.js`，自动生成模拟用户问法并跑检索命中率测试

全程可以完全离线运行（只有第一次生成向量时需要联网下载一次本地 embedding 模型）。

## 关于"本地向量库"的一点说明

需求文档里提到用 Chroma，但 Chroma 的 JS 客户端本质是一个 HTTP 客户端，真正的存储引擎是一个独立的 Chroma 服务进程，目前只能通过 Python（`pip install chromadb` + `chroma run`）或 Docker 启动，没有纯 Node.js 内嵌版本。

这里改用 **[vectra](https://github.com/Stevenic/vectra)** —— 一个纯 Node.js 实现的轻量级本地向量库，数据直接存在本地文件夹里，不需要启动任何额外的服务进程，跟 `backend/` 项目的技术栈保持一致。检索效果（余弦相似度 + top-K）跟 Chroma 是一样的，只是不叫这个名字。

## 目录结构

```
local-kb-tool/
├── kb-docs/                # 放你的 .docx 知识库文件（已 gitignore，不提交原文）
│   ├── .gitkeep
│   ├── diet/                # 多知识库时，每个知识库一个子目录（名字自定）
│   └── body-composition/
├── data/                    # 本地向量索引存储目录（运行 build-index 后自动生成，已 gitignore）
│   └── index/
│       ├── diet/               # 对应 kb-docs/diet/ 的索引
│       └── body-composition/   # 对应 kb-docs/body-composition/ 的索引
├── src/
│   ├── docReader.js         # 读取 .docx，用 mammoth 提取纯文本
│   ├── chunker.js           # 按段落切分成小片段
│   ├── embedder.js          # 用 @xenova/transformers 做本地 embedding
│   ├── vectorStore.js       # 封装 vectra：建索引 / 存 / 查
│   ├── keywordScore.js      # 关键词重合度打分，查询时跟语义相似度混合排序
│   ├── kbPaths.js           # 解析 --kb <名字> 参数，算出对应的文档目录 / 索引目录
│   ├── buildIndex.js        # npm run build-index 的入口
│   ├── query.js             # npm run query 的入口，检索逻辑抽成 retrieve() 供其他脚本复用
│   ├── bailianClient.js     # 调用阿里云百炼通用模型接口，仅供检索效果测试脚本使用
│   ├── genTestQuestions.js  # npm run gen-test-questions 的入口
│   └── evalRetrieval.js     # npm run eval-retrieval 的入口
├── eval-reports/            # 检索效果测试报告输出目录（已 gitignore）
├── .env.example
└── package.json
```

## 快速开始

### 单知识库（默认用法，不用管 `--kb`）

```bash
cd local-kb-tool
npm install

# 把你的 .docx 知识库文件放进 kb-docs/ 目录

npm run build-index
# 首次运行会从 Hugging Face 下载一次本地 embedding 模型（几十 MB），之后完全离线

npm run query -- "需要注册吗"
npm run query -- "怎么瘦肚子"
```

### 多个独立知识库

给每个知识库起个名字，文档放进 `kb-docs/<名字>/`，建索引和查询时都带上 `--kb <名字>`，各知识库的索引完全独立存放，互不影响、查询也不会混在一起：

```bash
# 把第一个知识库的 .docx 放进 kb-docs/diet/，第二个放进 kb-docs/body-composition/

npm run build-index -- --kb diet
npm run build-index -- --kb body-composition

npm run query -- --kb diet "需要注册吗"
npm run query -- --kb body-composition "微胖和瘦胖子怎么区分"
```

已经在用单知识库（没传过 `--kb`）的现有索引不受影响，继续用 `npm run build-index` / `npm run query -- "问题"`（不加 `--kb`）就行，走的还是原来的 `kb-docs/`、`data/index/` 默认目录。

如果你想完全自定义目录、不用 `--kb` 这套命名约定，`KB_DOCS_DIR`/`KB_INDEX_DIR` 环境变量仍然可用，且优先级高于 `--kb`（两者都设置时以环境变量为准）。

> 用 `npm run query` 时问题参数前要加 `--`（`npm run query -- "问题"`），否则 npm 不会把参数透传给脚本。

## 检索效果批量测试

人工一个个想问题去测检索效果太慢，这两个脚本自动化了这件事：

```bash
# 第一步：给 diet 和 body-composition（或 EVAL_KB_NAMES 指定的知识库）里的每个片段
# 各生成 3-5 个模拟用户口语化问法（调用百炼通用模型，需要配置 BAILIAN_API_KEY）
npm run gen-test-questions

# 第二步：拿生成的问题逐个跑检索，看能不能把"生成这个问题时依据的那个片段"
# 检索回来、排第几名
npm run eval-retrieval
```

跑完会在 `eval-reports/` 下生成一份带时间戳的报告，包含：

- 总体命中率：排名第 1（理想情况）/ 命中但排名靠后 / 完全未命中，各自的数量和占比
- "需要关注的问题清单"：只列出排名靠后或者没检索到的那些问题，每条都附上测试问法、对应的知识点原文、以及检索实际返回的第 1 名内容，方便你直接判断是真的检索出了问题，还是知识库里恰好有另一段同样合理的内容顶替了它

**"知识点"的操作化定义**：这里把"索引里的每一个片段（chunk）"当作一个知识点——建索引时已经按 FAQ 的 Q/A 边界或固定字符数切分过，每个片段本身就相对独立，不需要再额外去理解文档的语义结构。

**关于"排名靠后"**：判断标准是"由这段内容生成的问题，检索时这段内容本身有没有排在第一位"。这个标准偏严格——如果知识库里恰好有两段内容都能合理回答同一个问题，被判定为"靠后"也不一定是真正的缺陷，报告里已经把原文都附上了，方便你自己判断。

生成的题库存在 `data/test-questions.json`（gitignore，不提交），下次只想重跑检索测试、不想重新花时间/调用次数生成问题，直接再跑一次 `npm run eval-retrieval` 就行，会复用已有的题库。想强制重新生成，直接删掉这个文件再跑 `gen-test-questions`。

## 配置项（可选，复制 `.env.example` 为 `.env` 后修改）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `KB_DOCS_DIR` | `./kb-docs` | 知识库 `.docx` 文件所在目录 |
| `KB_INDEX_DIR` | `./data/index` | 本地向量索引存储目录 |
| `KB_CHUNK_CHARS` | `500` | 每个片段的最大字符数（按段落切分，不会切碎单个段落，超长段落才会硬切；"Q："开头的问答片段不受此限制，见下方说明） |
| `KB_TOP_K` | `5` | 查询时返回的最相关片段数量 |
| `KB_EMBEDDING_MODEL` | `Xenova/bge-small-zh-v1.5` | 本地 embedding 模型，需是 transformers.js 支持的模型（中文场景不建议换成纯英文模型，见下方说明） |
| `KB_QUERY_INSTRUCTION` | （内置 BGE 官方推荐前缀） | 查询时自动加在问题前面的检索指令前缀，换了非 BGE 模型可以设成空字符串关掉 |
| `KB_HF_ENDPOINT` | `https://huggingface.co` | 下载 embedding 模型的地址，国内连不上/超时时改成 `https://hf-mirror.com`（URL 结构兼容，直接替换即可） |
| `KB_KEYWORD_WEIGHT` | `0.35` | 混合检索里关键词重合度的权重（0~1），语义相似度权重 = 1 减去这个值，设成 0 即为纯语义检索 |
| `BAILIAN_API_KEY` | 无 | 检索效果测试脚本用，调用阿里云百炼通用模型接口生成模拟问法，可直接复用 `backend/.env` 里的值 |
| `BAILIAN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 同上 |
| `BAILIAN_MODEL` | `qwen-plus` | 同上 |
| `EVAL_KB_NAMES` | `diet,body-composition` | 检索效果测试要覆盖的知识库名字，逗号分隔 |
| `EVAL_GEN_DELAY_MS` | `400` | 生成测试问法时两次调用百炼接口之间的间隔（毫秒） |

### 关于混合检索（语义 + 关键词）

`query.js` 现在不是单纯按向量相似度排序，而是：语义检索先取一批候选片段（比默认返回数量多几倍），对每个候选片段额外算一个"关键词重合度"分数（`keywordScore.js`，用字符 bigram 重合比例，不依赖任何中文分词库），再按 `综合分 = (1 - KB_KEYWORD_WEIGHT) × 语义分 + KB_KEYWORD_WEIGHT × 关键词分` 重新排序取前几名。

加这个是因为发现了一个真实案例：查"需要注册吗"时，FAQ 里精确匹配的问答（"Q：需要注册吗？"）语义相似度只有 0.5552，被一段话题相关但答非所问的产品背景介绍（0.5590）反超排到第 1。这段背景介绍文字量大、反复出现"秘书""饮食规划"等产品相关词，容易被 `bge-small`（一个比较轻量的模型）误判成语义相关；而关键词重合度上，FAQ 那句因为原文就有"注册"这两个字，重合度是 1.0，背景介绍是 0。混合之后综合分变成 0.71 vs 0.36，排序正确了。

查询结果里会同时打印三个分数（综合 / 语义 / 关键词），方便看清楚一个片段是靠语义还是靠关键词排上来的。

### 关于 embedding 模型的选择

最开始用的是 `Xenova/all-MiniLM-L6-v2`，实测发现完全不同的两个中文问题（"需要注册吗" vs "怎么瘦肚子"）检索出来的相似度最高片段是同一个、且跟问题都不相关——这个模型主要是英文语料训练的，中文语义理解能力很弱，生成的向量对中文来说接近噪音，排序不可靠。

换成了 **`Xenova/bge-small-zh-v1.5`**（BAAI 出的中文专用 embedding 模型），并按官方建议给查询文本加了检索指令前缀（存文档片段时不加，只在查询时加，见 `embedder.js` 的 `embedQuery`），检索相关性明显改善。如果之后想换其他模型，选 transformers.js 支持、且明确训练过中文或多语言语料的模型（比如 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`），不要用纯英文模型。

## 常见问题（国内网络环境）

- **`npm install` 时 `sharp` 报错 "Request timed out"**：`sharp` 装依赖时要从 GitHub Releases 下载一个二进制文件，国内经常超时。换成镜像：
  ```bash
  export npm_config_sharp_binary_host="https://npmmirror.com/mirrors/sharp"
  export npm_config_sharp_libvips_binary_host="https://npmmirror.com/mirrors/sharp-libvips"
  npm install
  ```
  如果 `npm install` 提示 `allow-scripts` 相关警告导致脚本没真正执行，先批准再重新触发：
  ```bash
  npm approve-scripts sharp
  npm rebuild sharp
  ```

- **`npm run build-index` 时报 `ConnectTimeoutError` / `fetch failed`**：说明连不上 huggingface.co 下载 embedding 模型（常见于国内网络，Node 的 `fetch` 不会自动走系统代理）。在 `.env` 里加一行换成镜像站：
  ```
  KB_HF_ENDPOINT=https://hf-mirror.com
  ```
  然后重新运行 `npm run build-index`。

## 验证情况

在开发环境里验证过（用程序生成的示例 `.docx` 测试文件）：`.docx` 读取 + 按段落切分逻辑、向量存储/检索链路（写入、按相似度排序、附带来源文档名和片段序号）都正确。开发环境本身出站网络连不上 Hugging Face 和 GitHub（`sharp` 依赖的下载源），所以真实 embedding 生成这一步没法在这里跑，这两处都是网络限制，不是代码问题。

后来在实际本地环境（真实 8 份知识库文档）里跑通了完整流程，并且发现并修复了一个真实问题：最初用的 `Xenova/all-MiniLM-L6-v2` 是英文模型，对中文检索效果很差（两个完全不同的问题会命中同一个不相关片段），换成中文专用的 `Xenova/bge-small-zh-v1.5` 之后检索相关性明显改善（详见上面"关于 embedding 模型的选择"）。

换模型之后又发现一个排序不够精准的问题：查"需要注册吗"时，正确答案（FAQ 里的对应问答）排在第 2 名，第 1 名是一段不相关的产品背景介绍，两者相似度分数非常接近。原因是 FAQ 文档里连续几个"Q：/A："问答对被合并进了同一个片段，"需要注册吗"这个问答被稀释在其他不相关问答中间，导致片段的向量语义变模糊。这跟之前在百炼知识库上真实遇到过的"问需要注册吗答错"是同一类问题，这次能在本地复现并定位到具体原因（分片粒度太粗），说明这个工具确实起到了交叉验证的作用。

修复方式：`chunker.js` 现在会识别"Q："开头的段落作为问答片段的边界，每个问答对（Q + 紧跟着的 A）独立成一个片段，不再跟其他问答合并，也不受 `KB_CHUNK_CHARS` 字符数限制拆开。这个规则只在文档里出现"Q："格式时才会触发，普通叙述性文档的切分行为不受影响。

多知识库（`--kb`）的隔离性用真实 `.docx` 文件跑过完整的 `build-index` → `query` 流程验证过：两个知识库各自建索引互不干扰，查询一个知识库时完全不会检索到另一个的内容（即使用另一个知识库的问题去查也只会返回低分的自身内容，不会误命中）；参数解析（`--kb name` / `--kb=name`，以及不传 `--kb` 时的默认行为）也逐一验证过。真实 embedding 生成这块因为开发环境网络限制没法在这里跑到底，跟前面提到的网络限制是同一个原因。

## 后续（第 3 部分，暂不做）

跟百炼检索结果并排对比的命令行交互，等你需要的时候再单独提出来做。

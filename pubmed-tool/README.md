# PubMed 文献自动抓取与预筛选工具

对应《PubMed 文献自动抓取与预筛选工具·需求文档》核心功能清单的第一到第四部分（第五部分"定时自动运行"暂不实现，先做成手动触发脚本）：

- [x] 1. 关键词检索 —— 默认 6 个关键词，可在 `.env` 里覆盖
- [x] 2. 调用 PubMed 官方 E-utilities 抓取标题/摘要/作者/期刊/年份/PMID/链接
- [x] 3. 自动预筛选（动物实验、发表过早、摘要过短、疑似纯药物/手术类研究）
- [x] 4. 候选清单展示与人工确认（Markdown 文件 + 复选框）
- [ ] 5. 定时自动运行 —— 未实现，仍是手动运行 `npm run fetch-pubmed`

**红线（按需求文档，不因效率考虑而改变）**：不抓取需要订阅权限的全文，只用公开的标题+摘要；不自动把抓到的内容写入知识库文档——"候选清单生成"是自动的，但"最终决定保留哪些文献"必须人工勾选确认，写进知识库前仍需人工提炼改写，不直接照搬摘要原文。

## 目录结构

```
pubmed-tool/
├── src/
│   ├── config.js           # 读取环境变量：关键词、限速、预筛选阈值等
│   ├── pubmedClient.js      # 封装 NCBI E-utilities：esearch（检索）+ efetch（抓取）+ XML 解析
│   ├── prefilter.js         # 自动预筛选规则
│   ├── candidateList.js     # 生成候选清单 Markdown / 解析人工勾选结果
│   ├── fetchPubmed.js       # npm run fetch-pubmed 的入口
│   ├── markKept.js          # npm run mark-kept 的入口（可选的批量勾选方式）
│   └── collectKept.js       # npm run collect-kept 的入口
├── candidates/               # 生成的候选清单 / 已保留清单（已 gitignore，只保留 .gitkeep）
├── .env.example
└── package.json
```

## 快速开始

```bash
cd pubmed-tool
npm install
cp .env.example .env   # 可选，不改也能用默认配置

npm run fetch-pubmed
```

跑完会在 `candidates/` 目录生成一份 `candidates-<日期>.md`，控制台也会提示具体路径。

打开这份文件（用任何文本编辑器，或者 VS Code / Typora 这种支持 Markdown 复选框预览的编辑器都行），逐条看标题和摘要，想保留的那条把 `- [ ] 保留` 改成 `- [x] 保留`，改完保存。

如果已经确定好篇号（比如先在别处记好了"第 8、10、11 篇要留"），也可以用脚本批量勾选，不用逐条手动改：

```bash
npm run mark-kept -- candidates/candidates-2026-07-17.md 8 10 11 14 16
```

然后跑：

```bash
npm run collect-kept -- candidates/candidates-2026-07-17.md
```

会在同一个目录生成 `kept-<日期>.md`，是一份干净的"已保留"清单，供你后续人工提炼总结、整理进知识库文档。

## 配置项（可选，复制 `.env.example` 为 `.env` 后修改）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `PUBMED_KEYWORDS` | 见下方默认关键词列表 | 自定义关键词列表，用 `\|` 分隔 |
| `PUBMED_RESULTS_PER_KEYWORD` | `15` | 每个关键词抓取最新文献的数量 |
| `PUBMED_API_KEY` | 无 | NCBI API Key，不填限速约 3 次/秒，申请后约 10 次/秒（免费申请：NCBI 账号设置里的 API Key Management） |
| `PUBMED_EMAIL` / `PUBMED_TOOL_NAME` | 无 / `pubmed-tool` | NCBI 建议携带的调用方身份信息，非强制 |
| `PUBMED_MIN_YEAR` | 当前年份 − 15 | 早于这一年的文献会被预筛选掉 |
| `PUBMED_MAX_AGE_YEARS` | `15` | 没填 `PUBMED_MIN_YEAR` 时，用这个值算最早年份 |
| `PUBMED_MIN_ABSTRACT_LENGTH` | `200` | 摘要字符数低于这个值会被预筛选掉 |
| `PUBMED_OUTPUT_DIR` | `./candidates` | 候选清单 / 已保留清单的输出目录 |

### 默认关键词列表

```
female college students weight management
young women dietary intervention
spot reduction adipose tissue
regional fat loss exercise
BMI body composition young adults
disordered eating prevention diet coaching
```

需求文档原本给的"spot reduction myth / localized fat loss"这个关键词实测在 PubMed 检索不到任何文献（措辞偏口语化，跟论文标题摘要常用的学术用词对不上）。换成了 `spot reduction adipose tissue` 和 `regional fat loss exercise` 两个更学术化的说法，覆盖"局部减脂"这个方向。

## 预筛选规则

`prefilter.js` 会过滤掉命中以下任一条件的文献（对应需求文档第三部分，粗筛为主，不追求 100% 准确，允许人工在候选清单末尾的"预筛选剔除清单"里核查有没有筛选过严）：

1. 标题或摘要包含动物实验关键词：`mice / mouse / rat / rats / rodent / rodents / murine / animal model / zebrafish`
2. 发表年份早于阈值（默认 15 年前），或者没能识别出发表年份
3. 摘要字符数低于阈值（默认 200，通常意味着会议摘要或数据不全）
4. 标题或摘要包含疑似纯药物/临床手术类关键词：`surgery / surgical / pharmacological / pharmacology / drug therapy / chemotherapy`

被剔除的文献不会从清单里完全消失——候选清单文件末尾有一个"预筛选剔除清单"，列出每篇被剔除的文献和具体原因，方便人工核查筛选规则本身有没有问题（比如把真正相关的文献误判成了动物实验）。

## 验证情况

在开发环境里验证过（用手工构造的示例 PubMed XML 响应，模拟真实的 E-utilities 返回格式，覆盖了结构化摘要多段落、`CollectiveName` 团体作者、`MedlineDate` 兜底解析年份等情况）：

- XML 解析（`pubmedClient.parseArticleXml`）能正确提取标题、多段摘要、作者、期刊、年份、PMID、链接
- 预筛选规则（`prefilter.js`）能正确识别动物实验、过旧文献、摘要过短，并给出具体原因
- 候选清单生成 + 人工勾选 + 回读解析（`candidateList.js`）完整跑通往返测试，勾选 `[x]` 后能正确提取出对应文献的完整信息

**没有验证过的部分**：真实调用 NCBI E-utilities（`esearch` / `efetch`）。这个开发环境的出站网络策略挡住了 `eutils.ncbi.nlm.nih.gov`（跟之前 backend 连不上阿里云、local-kb-tool 连不上 Hugging Face 是同一类限制），错误处理确认是干净报错、不影响前面验证过的逻辑。

后来在实际本地环境（真实调用 NCBI 接口）跑通了完整流程：6 个关键词共检索到 82 篇文献，预筛选保留 67 篇、剔除 15 篇，候选清单正常生成。跑的过程中发现并修复了一个真实问题：部分文献的标题/摘要/期刊/作者名里，重音字母和数学符号（如 `è`、`≥`）不是标准 XML 转义，而是以 HTML 数字实体的字面文本形式存在（`&#xe9;`、`&#x2265;` 这种），XML 解析库不会自动处理这种情况，导致清单里原样显示这些代码。`pubmedClient.js` 的 `textOf()` 现在会对提取出的每个字段统一做一次实体解码（数字实体 + `&amp; &lt; &gt; &quot; &apos; &nbsp;` 这几个常见命名实体），修复后特殊字符能正常显示。

## 后续（第五部分，暂不做）

定时自动运行（比如每天/每周自动跑一次 `fetch-pubmed`），等你需要的时候再说，可以用系统的 `cron` 或者其他任务调度工具，不需要额外改代码逻辑。

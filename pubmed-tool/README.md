# PubMed 文献自动抓取与预筛选工具

这个文件夹对应两份需求文档，是先后两次迭代：

**《PubMed 文献自动抓取与预筛选工具·需求文档》**（第一到第四部分，第五部分"定时自动运行"当时先不做）：

- [x] 1. 关键词检索 —— 默认关键词列表，可在 `.env` 里覆盖
- [x] 2. 调用 PubMed 官方 E-utilities 抓取标题/摘要/作者/期刊/年份/PMID/链接
- [x] 3. 自动预筛选（动物实验、发表过早、摘要过短、疑似纯药物/手术类研究）
- [x] 4. 候选清单展示与人工确认（Markdown 文件 + 复选框）

**《身材管理专项知识库·每周自动更新工具需求文档》**（在上面的基础上扩展）：

- [x] 1. 增量比对逻辑 —— 记录已处理过的 PMID，避免重复抓取
- [x] 2. AI 辅助相关性打分与风险标记
- [x] 3. cron 定时任务设置说明（见文末）

**红线（按两份需求文档，不因效率/自动化程度提升而改变）**：不抓取需要订阅权限的全文，只用公开的标题+摘要；不自动把抓到的内容写入知识库文档——"候选清单生成"（含检索、抓取、预筛选、AI 打分排序）可以自动跑，但"最终决定保留哪些文献"必须人工勾选确认，写进知识库前仍需人工提炼改写，不直接照搬摘要原文；AI 的打分和风险标记仅供参考，不作为自动采纳或自动排除的依据。

## 目录结构

```
pubmed-tool/
├── src/
│   ├── config.js           # 读取环境变量：关键词、限速、预筛选阈值、AI 打分配置等
│   ├── pubmedClient.js      # 封装 NCBI E-utilities：esearch（检索，支持按天数限定范围）+ efetch（抓取）+ XML 解析
│   ├── prefilter.js         # 自动预筛选规则
│   ├── processedStore.js    # 已处理 PMID 记录的读写（增量比对用）
│   ├── aiScorer.js          # 调用阿里云百炼给文献打相关性分数 + 风险标记
│   ├── candidateList.js     # 生成候选清单 Markdown（含 AI 打分/风险标记）/ 解析人工勾选结果
│   ├── fetchPubmed.js       # npm run fetch-pubmed 的入口（手动、一次性抓取，不做增量/AI打分）
│   ├── weeklyUpdate.js      # npm run weekly-update 的入口（增量抓取 + AI 打分排序，可配 cron 定时跑）
│   ├── runLog.js            # 每次 weekly-update 运行都往 logs/weekly-update.log 追加一条记录
│   ├── rescueCandidate.js   # npm run rescue-candidate 的入口（把被预筛选误判排除的文献手动加回候选清单）
│   ├── markKept.js          # npm run mark-kept 的入口（可选的批量勾选方式）
│   └── collectKept.js       # npm run collect-kept 的入口
├── candidates/               # 生成的候选清单 / 已保留清单（已 gitignore，只保留 .gitkeep）
├── data/                      # 已处理 PMID 记录（已 gitignore，运行 weekly-update 后自动生成）
├── logs/                      # weekly-update 每次运行的记录（已 gitignore，自动生成）
├── false-positive-log.md      # 预筛选误判案例记录（会提交到仓库，持续积累）
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

## 每周增量更新（`weekly-update`）

跟上面手动的 `fetch-pubmed` 不同，`weekly-update` 专门用来做"定期检查有没有新文献"这件事：只检索最近 N 天新发表的文献、自动跳过已经处理过的 PMID、用 AI 给通过预筛选的文献打相关性分数和风险标记，最后生成一份按分数从高到低排好序的候选清单。

```bash
npm run weekly-update              # 默认检索最近 7 天
npm run weekly-update -- --days 14 # 自定义天数
```

第一次配置前，还需要在 `.env` 里填 `BAILIAN_API_KEY`（AI 打分要用，见下面"AI 辅助打分"一节的说明）。

运行时的日志会依次显示：本次抓到多少篇（去重后）、跟已处理记录比对后剩多少篇新文献、预筛选剔除多少篇、AI 打分处理了多少篇（以及其中多少篇带风险标记）、最终候选清单包含多少篇。

**如果这次检索范围内没有新文献**（比对已处理记录后一篇不剩），脚本会打印"本次无新文献"直接结束，不会生成候选清单文件，也不需要你做任何事——这种情况是完全自动、不需要人工介入的，只有真正抓到新文献时才会生成候选清单等你确认。

生成的候选清单文件名是 `weekly-<日期>.md`（区别于 `fetch-pubmed` 生成的 `candidates-<日期>.md`，避免同一天两个命令都跑了互相覆盖），后续勾选、`mark-kept`、`collect-kept` 的用法跟前面完全一样。

已处理过的 PMID 记录在 `data/processed-pmids.json`（不管这篇文献最后是保留还是被预筛选剔除，只要抓取评估过就会记进去，下次不会再重复抓取）。这个文件不提交到 git，删掉它相当于"重置记忆"，下次运行会把检索范围内的所有文献都当成新的重新处理一遍。

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
| `PUBMED_WEEKLY_DAYS` | `7` | `weekly-update` 默认检索最近多少天的新文献，`--days` 参数可临时覆盖 |
| `PUBMED_PROCESSED_STORE` | `data/processed-pmids.json` | 已处理 PMID 记录的存储路径 |
| `BAILIAN_API_KEY` | 无（必填才能用 AI 打分） | 阿里云百炼 API Key，用于 AI 辅助打分；和 `backend/.env` 是两份独立配置，同一账号可以复用同一个值 |
| `BAILIAN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 百炼 OpenAI 兼容模式的地址 |
| `BAILIAN_MODEL` | `qwen-plus` | AI 打分调用的模型 |
| `AI_SCORER_DELAY_MS` | `300` | 每篇文献打分之间的等待时间（毫秒） |

### 默认关键词列表

```
female college students weight management
young women dietary intervention
spot reduction adipose tissue
regional fat loss exercise
BMI body composition young adults
disordered eating prevention diet coaching
normal-weight obesity
hidden obesity
female weight management
diet
eating behavior
```

前 6 个是最初就有的（需求文档原本给的"spot reduction myth / localized fat loss"这个关键词实测在 PubMed 检索不到任何文献，措辞偏口语化，换成了 `spot reduction adipose tissue` 和 `regional fat loss exercise` 两个更学术化的说法）。后 5 个是《每周自动更新工具需求文档》里补充的。

需要提醒一点：`diet` 这个词单独作为关键词非常宽泛，几乎能匹配任何提到"饮食"的论文（糖尿病饮食、临床营养干预等各种不相关方向都会混进来），预筛选规则能挡掉一部分明显不相关的（动物实验、纯药物研究等），但挡不住"话题沾边但跟产品方向关系不大"的文献。如果实际跑起来发现这个关键词贡献的候选质量偏低、噪音偏多，可以把它从关键词列表里去掉，或者换成更具体的搭配（比如 `diet behavior female college students`）。

## 预筛选规则

`prefilter.js` 会过滤掉命中以下任一条件的文献（对应需求文档第三部分，粗筛为主，不追求 100% 准确，允许人工在候选清单末尾的"预筛选剔除清单"里核查有没有筛选过严）：

1. 标题或摘要包含动物实验关键词：`mice / mouse / rat / rats / rodent / rodents / murine / animal model / zebrafish / turkeys / bee / bees / cricket / crickets / cat / cats / pig / pigs / swine / fish / tilapia / cow / cows / cattle / bovine / chicken / chickens / poultry / broiler / deer`
2. 发表年份早于阈值（默认 15 年前），或者没能识别出发表年份
3. 摘要字符数低于阈值（默认 200，通常意味着会议摘要或数据不全）
4. 标题或摘要包含疑似纯药物/临床手术类关键词：`surgery / surgical / pharmacological / pharmacology / drug therapy / chemotherapy`

被剔除的文献不会从清单里完全消失——候选清单文件末尾有一个"预筛选剔除清单"，列出每篇被剔除的文献和具体原因，方便人工核查筛选规则本身有没有问题（比如把真正相关的文献误判成了动物实验）。

**动物实验关键词列表的一点权衡**：最初只有 `mice/rat/rodent` 几个词，实测发现漏掉了火鸡、蜜蜂、蟋蟀、猫、猪、罗非鱼这些真实出现过的研究动物，扩充列表补上了这些。但这类词天生存在误伤风险——比如"蟋蟀粉作为人类膳食蛋白来源"这种其实跟产品方向相关的论文，会因为标题里出现"cricket"被误判成动物实验剔除掉；"鸡肉""鱼""牛"这些词在人类饮食摄入类研究里也很常见（"参与者摄入鸡胸肉"之类的表述）。这个关键词列表天然是"宁可错杀、不追求完美"的粗筛，被误伤的文献仍然会带着剔除原因出现在"预筛选剔除清单"里，供人工核查发现有没有筛选过严；真正更彻底的解决方案是解析 PubMed 返回的 MeSH 主题词（比如同时标了 `Animals` 但没标 `Humans` 的记录基本可以确认是动物实验），比关键词猜测更准确，但目前 `pubmedClient.js` 还没有解析这部分数据，算是一个可以考虑的后续改进方向。

预筛选规则不止会误伤动物实验相关的判断——"疑似纯药物/临床手术类研究"这条也有同样的通病：关键词匹配分不清"这篇论文提到手术是因为它本身讲手术"和"这篇论文提到手术只是为了说明它把手术类研究排除在外了"。真实遇到过的例子是一篇讲"长期禁食对身体成分影响"的系统综述，因为摘要里大概率有一句"排除了涉及药物或手术干预的研究"（描述它自己的筛选标准），被误判成手术类研究整篇排除掉了。

## 预筛选误判的记录与手动找回

发现类似"明显应该保留、却被预筛选误判排除"的情况，先不急着改预筛选规则本身（这类问题往往靠关键词很难根治，改动收益和复杂度需要权衡），而是：

1. 把这篇文献手动加回对应的候选清单：

```bash
npm run rescue-candidate -- candidates/weekly-2026-07-17.md 42440276
```

这条命令会用真实 PMID 重新从 PubMed 抓一遍这篇文献的完整信息，接在候选清单主列表末尾（带 `[ ] 保留` 复选框和"人工手动加回"的备注），不影响清单里其他条目。

2. 在 `false-positive-log.md`（提交到仓库里，持续积累）里记一条案例：文献信息 + 命中的规则 + 推测原因。等积累到 3-5 条同类案例后，再回头一起判断要不要真正调整预筛选逻辑。

## AI 打分驱动的"低相关性"分组

`weekly-update` 生成的候选清单里，AI 打分为 **1 分**（"基本不相关"）的文献，不会跟其他候选文献混在主列表里，而是自动挪到清单末尾的"低相关性文献"分组，减少你翻阅主列表时的干扰。这些文献仍然带着完整的复选框和详细信息，如果你不同意 AI 的判断，一样可以勾选保留——AI 打分只影响"展示顺序/分组"，不影响"能不能被保留"这个最终决定权。

## 增量比对（避免重复抓取）

`weekly-update` 每次运行都会：

1. 检索最近 N 天内的文献，跟 `data/processed-pmids.json` 里已经记录过的 PMID 比对，只保留真正的新文献往下走
2. 不管这批新文献最后是通过预筛选、被预筛选剔除、还是 AI 打分完成，评估过的 PMID 都会写回这份记录

也就是说"已处理"指的是"已经抓取并评估过"，不等于"已经采纳"——被预筛选剔除的文献也不会在下次检索同一时间窗口时被重复抓取和重复评估。

## AI 辅助打分与风险标记

对每篇通过预筛选的新文献，`aiScorer.js` 会调用阿里云百炼的通用模型接口（`qwen-plus`，走 OpenAI 兼容模式，不是 `backend/` 项目里那个绑定了知识库人设的应用），请它输出：

- **相关性打分**（1-5 分）：跟"女大学生饮食/体重体脂管理"这个产品方向的贴合程度，候选清单按这个分数从高到低排序
- **风险标记**（可能多个，也可能没有）：
  - `涉及具体剂量/药物`
  - `局部减脂类争议话题`
  - `极端饮食方法`
  - `特定病理人群`

带风险标记的文献，在候选清单里会有醒目的 `⚠️ 需要人工重点复核` 提示，但**不会被自动过滤掉**，仍然正常出现在清单里，风险标记只是提醒你审阅时多留意，最终保留/丢弃完全由人工判断。

单篇打分失败（网络问题、模型返回格式不对等）不会导致整批处理中断——失败的那篇会正常出现在候选清单里，只是没有 AI 打分和风险标记，等同于"这篇需要你自己判断，AI 没能提供参考意见"。

## 验证情况

在开发环境里验证过（用手工构造的示例 PubMed XML 响应，模拟真实的 E-utilities 返回格式，覆盖了结构化摘要多段落、`CollectiveName` 团体作者、`MedlineDate` 兜底解析年份等情况）：

- XML 解析（`pubmedClient.parseArticleXml`）能正确提取标题、多段摘要、作者、期刊、年份、PMID、链接
- 预筛选规则（`prefilter.js`）能正确识别动物实验、过旧文献、摘要过短，并给出具体原因
- 候选清单生成 + 人工勾选 + 回读解析（`candidateList.js`）完整跑通往返测试，勾选 `[x]` 后能正确提取出对应文献的完整信息

**没有验证过的部分**：真实调用 NCBI E-utilities（`esearch` / `efetch`）。这个开发环境的出站网络策略挡住了 `eutils.ncbi.nlm.nih.gov`（跟之前 backend 连不上阿里云、local-kb-tool 连不上 Hugging Face 是同一类限制），错误处理确认是干净报错、不影响前面验证过的逻辑。

后来在实际本地环境（真实调用 NCBI 接口）跑通了完整流程：6 个关键词共检索到 82 篇文献，预筛选保留 67 篇、剔除 15 篇，候选清单正常生成。跑的过程中发现并修复了一个真实问题：部分文献的标题/摘要/期刊/作者名里，重音字母和数学符号（如 `è`、`≥`）不是标准 XML 转义，而是以 HTML 数字实体的字面文本形式存在（`&#xe9;`、`&#x2265;` 这种），XML 解析库不会自动处理这种情况，导致清单里原样显示这些代码。`pubmedClient.js` 的 `textOf()` 现在会对提取出的每个字段统一做一次实体解码（数字实体 + `&amp; &lt; &gt; &quot; &apos; &nbsp;` 这几个常见命名实体），修复后特殊字符能正常显示。

### 增量更新 + AI 打分部分的验证情况

同样受限于开发环境连不上 NCBI 和阿里云百炼，真实的 `weekly-update` 端到端调用没法在开发环境里跑，但用构造数据完整验证过组合起来的逻辑是对的：

- **增量比对**：模拟"上次已处理过 PMID 1、2，这次检索到 1/2/3/4/5"，能正确识别出 3、4、5 才是新文献
- **预筛选 + AI 打分排序**：模拟一批新文献，含动物实验、极端饮食话题等场景，验证预筛选正确剔除动物实验文献，AI 打分（模拟返回值）驱动候选清单按分数从高到低排序
- **风险标记不过滤**：命中风险标记（比如"极端饮食方法"）的文献会带 `⚠️` 醒目提示，但仍然正常出现在候选清单里，不会被自动剔除
- **增量存储更新**：一轮处理完成后，无论保留还是剔除，涉及的 PMID 都正确写回 `processed-pmids.json`，下次同样的检索范围不会重复抓取
- **"本次无新文献"安静退出**：模拟所有检索结果都已在处理记录里的情况，确认脚本会打印提示并直接结束，不生成候选清单文件
- `aiScorer.js` 的响应解析（`parseScoreResponse`）单独测试过：能正确处理干净的 JSON、包在 markdown 代码块里的 JSON、模型编造的风险标记会被过滤掉、分数超出 1-5 范围或返回内容根本不是 JSON 时都能正确抛出可读的错误信息

真实调用阿里云百炼的部分（提示词效果怎么样、qwen-plus 打分是否准确、真实网络环境下的报错情况）需要你在本地配好 `BAILIAN_API_KEY` 后实际跑一遍验证。

### 本地真实环境验证结果

在本地联网环境跑通了完整的 `weekly-update`：11 个关键词检索到 64 篇文献，预筛选保留 48 篇、剔除 15 篇，AI 打分（`qwen-plus`）全部成功，48 篇里有 31 篇带风险标记。人工抽查后确认：**AI 打分和风险标记在相关性 3 分以上的文献里判断得比较准，不需要调整提示词**；真正的问题出在预筛选的动物实验关键词覆盖不全，漏掉了火鸡、蜜蜂、蟋蟀、猫、猪、罗非鱼、鹿这些研究动物。针对这个发现做了两处改进（都已完成，见上面对应章节）：

1. 扩充了 `prefilter.js` 的动物实验关键词列表
2. `candidateList.js` 新增了"低相关性文献"分组——AI 打分 1 分的文献自动挪到候选清单末尾单独分组，减少人工翻阅主列表的干扰，但仍保留复选框，不影响人工最终决定权

## 运行日志（不管手动运行还是 cron 触发都会记）

`weeklyUpdate.js` 每次运行结束（不管是抓到新文献生成了候选清单、判断"本次无新文献"、还是中途报错），都会往 `logs/weekly-update.log` 追加一行带时间戳的记录，不需要额外配置，手动运行和 cron 定时触发都一样会记：

```bash
cat pubmed-tool/logs/weekly-update.log
```

内容大概长这样：

```
[2026-07-17T03:00:12.481Z] 检索最近 7 天 | 抓到 5 篇 | 本次无新文献
[2026-07-24T03:00:15.223Z] 检索最近 7 天 | 抓到 12 篇 | 新文献 8 篇 | 预筛选保留 6 剔除 2 | AI 打分完成（2 篇风险标记）| 候选清单: candidates/weekly-2026-07-24.md
[2026-07-31T03:00:08.007Z] 运行失败: PubMed esearch.fcgi 请求失败: HTTP 403
```

看最后一行的时间戳，就知道上次是什么时候跑的；看内容就知道跑成功了还是失败了、有没有生成新的候选清单。这个文件不提交到仓库（本地运行状态），删掉相当于清空历史记录，不影响下次继续正常运行。

## 定时自动运行（cron）

`weekly-update` 本身只是一个手动运行的命令，"每周自动触发"需要借助系统自带的 `cron`（Mac / Linux 都有，操作完全一样）来定时执行它。以下是具体设置步骤。

### 第一步：确认 node 的完整路径

cron 运行时用的是一个非常精简的环境变量，通常找不到你终端里能直接用的 `node` 命令，需要用完整路径：

```bash
which node
```

记下这个路径（比如 `/usr/local/bin/node` 或 `/opt/homebrew/bin/node`），下面会用到。

### 第二步：编辑 crontab

```bash
crontab -e
```

会打开一个编辑器（默认可能是 vim；不熟悉的话可以先执行 `export EDITOR=nano` 再执行上面这条，改用更好操作的 nano）。加入这一行（把路径换成你自己的实际路径）：

```
0 3 * * 1 cd /Users/你的用户名/Desktop/AI-试2/pubmed-tool && /usr/local/bin/node src/weeklyUpdate.js >> logs/cron-raw.log 2>&1
```

这一行的意思是：**每周一凌晨 3 点**，自动进入 `pubmed-tool` 目录运行 `weekly-update`。末尾 `>> logs/cron-raw.log 2>&1` 是个额外的保险——把完整的控制台输出也存一份原始记录，用于万一脚本自身的日志没能正常写入时的兜底排查（比如 node 本身启动失败这种脚本代码管不到的极端情况），日常查看运行状态用上面的 `logs/weekly-update.log` 就够了，不需要看这份原始记录。

cron 的时间格式是 `分 时 日 月 星期`，`0 3 * * 1` = 每周一 03:00。想改成每天就用 `0 3 * * *`；想改成每周日，把最后的 `1` 换成 `0`。

保存退出编辑器：vim 是按 `Esc` 然后输入 `:wq` 回车；nano 是 `Ctrl+O` 保存、`Ctrl+X` 退出。

### 第三步：确认定时任务已生效

```bash
crontab -l
```

能看到你刚才加的那一行，就说明设置成功了。

### macOS 需要注意的一点

macOS（Catalina 及更新版本）出于隐私保护，`cron` 默认可能没有权限访问你的文件（尤其是 `~/Desktop` 里的文件）。如果到了设定时间却完全没有生成日志、或者日志里有权限相关的报错，去**系统设置 → 隐私与安全性 → 完全磁盘访问权限**，把 `/usr/sbin/cron` 加进去并打开开关。

### 想先手动测试一下 cron 这一行本身对不对

不用等到真正到点，直接把 crontab 里那一整行 `cd ... && /usr/local/bin/node ...` 复制到终端手动跑一次，确认没有报错、日志文件正常写入，再放心交给 cron 定时执行。

### 想停止定时任务

```bash
crontab -e
```

把对应那一行删掉（或者在行首加 `#` 注释掉），保存退出即可。

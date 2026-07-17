# 预筛选误判记录

用于记录"预筛选规则误伤了本该保留的文献"这类案例。每发现一次就在下面加一条。等积累到 3-5 条同类案例（比如都是同一条规则、同一类原因反复误判）后，再回头一起看要不要真正调整预筛选逻辑——可能的方向包括：改用更精确的判断方式（比如解析 PubMed 的 MeSH 主题词，而不是纯关键词猜测）、给规则加豁免条件、或者接受现状（这个工具本来就是"减少人工工作量"，不追求 100% 准确）。

发现误判后，用这个命令把文献手动加回对应的候选清单：

```bash
npm run rescue-candidate -- candidates/weekly-<日期>.md <PMID>
```

## 案例列表

### 案例 1 —— 2026-07-17

- **PMID**: 42440276
- **标题**: Duration-Dependent Changes in Body Composition During Prolonged Fasting: A Systematic Review and Meta-Analysis
- **被误判命中的规则**: 疑似纯药物/临床手术类研究（`CLINICAL_NONDIET_REGEX`：surgery/pharmacological 等关键词）
- **推测原因**: 标题明显是讲禁食（fasting）对身体成分的影响，跟"极端饮食方法"这个方向直接相关。大概率是摘要里出现了"排除了涉及药物或手术干预的研究"这类描述本文筛选标准的句子，被关键词规则误判成"这篇本身是手术/药物类研究"——这是纯关键词匹配的通病：分不清"提到手术是为了说明排除了它"和"这篇就是讲手术的"。
- **处理**: 已用 `npm run rescue-candidate` 手动加回对应候选清单

---

（下面继续添加新案例）

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { retrieve } = require('./query');

const QUESTIONS_FILE = path.join(__dirname, '..', 'data', 'test-questions.json');
const REPORT_DIR = path.join(__dirname, '..', 'eval-reports');

function isSameChunk(result, entry) {
  return result.source === entry.source && result.chunkIndex === entry.chunkIndex;
}

async function evalEntry(entry) {
  const results = [];

  for (const question of entry.questions) {
    let topK;
    try {
      topK = await retrieve(entry.kbName, question);
    } catch (err) {
      results.push({ question, error: err.message });
      continue;
    }

    const rankIndex = topK.findIndex((r) => isSameChunk(r, entry));
    const rank = rankIndex === -1 ? null : rankIndex + 1;
    const topResult = topK[0];

    results.push({
      question,
      rank,
      topMatch: topResult
        ? {
            source: topResult.source,
            chunkIndex: topResult.chunkIndex,
            textPreview: topResult.text.slice(0, 80),
            hybridScore: topResult.hybridScore,
          }
        : null,
    });
  }

  return results;
}

function pct(n, total) {
  return total === 0 ? '0.0' : ((n / total) * 100).toFixed(1);
}

function renderReport(allResults) {
  const lines = [];
  lines.push('# 知识库检索效果测试报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');

  let totalQ = 0;
  let rank1 = 0;
  let rankOther = 0;
  let missed = 0;
  let errored = 0;
  const problems = [];

  for (const { entry, results } of allResults) {
    for (const r of results) {
      totalQ += 1;
      if (r.error) {
        errored += 1;
        problems.push({ entry, ...r, category: '检索出错' });
        continue;
      }
      if (r.rank === 1) {
        rank1 += 1;
        continue;
      }
      if (r.rank === null) {
        missed += 1;
        problems.push({ entry, ...r, category: '未命中（不在 Top-K 内）' });
        continue;
      }
      rankOther += 1;
      problems.push({ entry, ...r, category: `命中但排名靠后（第 ${r.rank} 名）` });
    }
  }

  lines.push('## 总体命中率');
  lines.push('');
  lines.push(`- 测试问题总数：${totalQ}`);
  lines.push(`- 排名第 1（理想情况）：${rank1}（${pct(rank1, totalQ)}%）`);
  lines.push(`- 命中但排名靠后：${rankOther}（${pct(rankOther, totalQ)}%）`);
  lines.push(`- 未命中（Top-K 内找不到对应知识点）：${missed}（${pct(missed, totalQ)}%）`);
  if (errored) lines.push(`- 检索出错：${errored}`);
  lines.push('');
  lines.push(
    '> "排名第 1" 是最理想情况：由这段知识点内容生成的问题，检索时这段内容本身应该排在第一位。' +
      '排名靠后或未命中不一定代表检索出了错——也可能是知识库里正好有另一段内容同样能回答这个问题——' +
      '但都值得人工看一眼，判断是真的检索精度问题，还是问法本身有歧义。'
  );
  lines.push('');
  lines.push('## 需要关注的问题清单');
  lines.push('');

  if (problems.length === 0) {
    lines.push('没有需要关注的问题，所有测试问题都精确命中了对应知识点，排名第 1。');
  } else {
    problems.forEach((p, i) => {
      lines.push(`### ${i + 1}. [${p.entry.kbName}] ${p.category}`);
      lines.push('');
      lines.push(`- 测试问法：${p.question}`);
      lines.push(`- 对应知识点来源：${p.entry.source}（第 ${p.entry.chunkIndex} 段）`);
      lines.push(`- 知识点原文预览：${p.entry.chunkPreview}...`);
      if (p.error) {
        lines.push(`- 错误信息：${p.error}`);
      } else if (p.topMatch) {
        lines.push(
          `- 实际检索到的第 1 名：${p.topMatch.source}（第 ${p.topMatch.chunkIndex} 段，综合打分 ${p.topMatch.hybridScore.toFixed(4)}）`
        );
        lines.push(`  > ${p.topMatch.textPreview}...`);
      } else {
        lines.push('- 检索结果为空');
      }
      lines.push('');
    });
  }

  return lines.join('\n');
}

async function main() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    console.error(`找不到测试题库文件（${QUESTIONS_FILE}），请先运行 npm run gen-test-questions`);
    process.exitCode = 1;
    return;
  }

  const entries = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf-8'));
  console.log(`读取到 ${entries.length} 个知识点，开始跑检索测试...`);

  const allResults = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const results = await evalEntry(entry);
    allResults.push({ entry, results });

    if ((i + 1) % 5 === 0 || i === entries.length - 1) {
      console.log(`  已测试 ${i + 1}/${entries.length}`);
    }
  }

  const report = renderReport(allResults);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const fileName = `retrieval-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  const filePath = path.join(REPORT_DIR, fileName);
  fs.writeFileSync(filePath, report, 'utf-8');

  console.log(`\n测试完成，报告已生成: ${filePath}`);
}

main().catch((err) => {
  console.error('检索测试失败:', err);
  process.exitCode = 1;
});

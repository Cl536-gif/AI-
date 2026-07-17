const fs = require('fs');
const path = require('path');
const config = require('./config');
const { parseReviewedMarkdown, renderKeptMarkdown } = require('./candidateList');

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('请提供已勾选过的候选清单文件路径，例如:');
    console.error('  npm run collect-kept -- candidates/candidates-2026-07-17.md');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`文件不存在: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  const markdown = fs.readFileSync(inputPath, 'utf-8');
  const kept = parseReviewedMarkdown(markdown);

  if (kept.length === 0) {
    console.log('没有找到任何被勾选为"保留"（[x]）的文献，请检查是否已经打勾保存。');
    return;
  }

  const generatedAt = new Date().toISOString();
  const output = renderKeptMarkdown(kept, generatedAt);

  fs.mkdirSync(config.outputDir, { recursive: true });
  const fileName = `kept-${generatedAt.slice(0, 10)}.md`;
  const outputPath = path.join(config.outputDir, fileName);
  fs.writeFileSync(outputPath, output, 'utf-8');

  console.log(`已保留 ${kept.length} 篇文献，清单已生成: ${outputPath}`);
}

main();

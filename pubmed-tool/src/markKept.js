const fs = require('fs');

// 按篇号批量把候选清单里的 "- [ ] 保留" 改成 "- [x] 保留"，用于已经在别处
// （比如聊天记录、笔记）确定好要保留哪几篇、只是想省去手动逐条打勾的场景。
// 正常流程仍然是直接打开 candidates-*.md 手动勾选，这个脚本只是一个可选的批量方式。

const filePath = process.argv[2];
const targetIndexes = process.argv.slice(3).map(Number);

if (!filePath || targetIndexes.length === 0) {
  console.error('用法: npm run mark-kept -- <候选清单文件路径> <篇号1> <篇号2> ...');
  process.exitCode = 1;
} else {
  const targets = new Set(targetIndexes);
  const content = fs.readFileSync(filePath, 'utf-8');
  const blocks = content.split('\n---\n');
  let matchedCount = 0;

  const updated = blocks.map((block) => {
    const heading = block.match(/^## (\d+)\./m);
    if (!heading) return block;
    const index = Number(heading[1]);
    if (!targets.has(index)) return block;
    if (block.includes('- [ ] 保留')) {
      matchedCount += 1;
      return block.replace('- [ ] 保留', '- [x] 保留');
    }
    return block;
  });

  fs.writeFileSync(filePath, updated.join('\n---\n'), 'utf-8');
  console.log(`已标记 ${matchedCount} / ${targets.size} 篇为保留（目标篇号: ${[...targets].sort((a, b) => a - b).join(', ')}）`);
}

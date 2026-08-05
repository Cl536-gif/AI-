const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  ['第1轮：学生身份不能误判食堂', 'scenario27-school-is-not-cafeteria.js'],
  ['第2轮：追问先回答及标点红线', 'scenario25-side-question-and-punctuation.js'],
  ['第3轮：精气神等目标表达', 'scenario23-goal-language-normalization.js'],
  ['第4轮：同句多个维度逐项处理', 'scenario26-multi-slot-queue.js'],
  ['第5轮：小炒肉识别与口味确认', 'scenario28-dish-taste-inference.js'],
  ['第6轮：确认时继续补充内容', 'scenario29-confirmation-with-supplement.js'],
  ['第7轮：哦对还有不是改口', 'scenario30-explicit-addition-not-correction.js'],
  ['第8轮：真实模型识别新增口味', 'scenario31-addition-real-graph.js'],
  ['第9轮：身体数据必须早于经期', 'scenario33-body-before-cycle.js'],
  ['第10轮：真实模型提取身体数据', 'scenario34-body-extraction-real.js'],
];

function main() {
  const failures = [];
  TESTS.forEach(([label, file], index) => {
    console.log(`\n========== ${label} ==========`);
    const result = spawnSync('node', [path.join(__dirname, file)], {
      cwd: path.resolve(__dirname, '../../..'),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0 || (result.stdout || '').includes('❌') || (result.stderr || '').includes('❌')) {
      failures.push(`${index + 1}. ${label}`);
    }
  });

  if (failures.length > 0) {
    throw new Error(`以下轮次失败:\n${failures.join('\n')}`);
  }
  console.log('\n✅ 10轮专项回归全部通过');
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

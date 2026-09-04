// 完整回归跑批脚本：把 manual-tests 目录下所有场景脚本（scenario1~14），
// 加上老架构那份 backend/manual-test-identity.js，按顺序跑一遍，
// 每个脚本的完整输出连同退出码一起写进一份带时间戳的日志文件里，
// 最后打印一份汇总表——不用再一个个手动跑、一个个复制粘贴终端输出。
//
// 用法：
//   cd backend
//   LANGGRAPH_DEBUG=1 node src/langgraph/manual-tests/run-all-regression.js
//
// 前置条件：
//   1. 需要真实网络访问 DashScope（跟其余脚本一样，这个编排脚本本身
//      不额外调用模型，但会把需要网络的子脚本一个个跑起来）。
//   2. scenario7/13/14 这三个需要真实HTTP接口，跑之前必须已经在另一个
//      终端执行 `npm start` 把服务起来（默认 http://localhost:3001）。
//      这个脚本会在跑到它们之前先探测一下服务有没有起来，没起来会
//      跳过并在汇总里标注，不会让整个跑批因为这一个卡住。
//
// 关于"通过/失败"的判断口径：
//   - 退出码非0：脚本本身抛了异常，明确失败。
//   - 输出里出现"❌"：脚本自带断言判定为不通过，明确失败。
//   - 退出码0且没有"❌"，但也没有"✅"：这类脚本（scenario1/2/3/5/6/7）
//     没有写自动断言，只是打印AI真实回复，需要人工对照脚本开头注释里
//     写的"预期行为"来判断，这个脚本只会在汇总里提示"需要人工核对"，
//     不会替你下判断——LLM输出的自然语言质量终究不是靠字符串匹配能
//     完全断定的。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MANUAL_TESTS_DIR = __dirname;
const BACKEND_DIR = path.resolve(__dirname, '../../..');
const CHAT_LANGGRAPH_URL = process.env.CHAT_LANGGRAPH_URL || 'http://localhost:3001/api/chat-langgraph';

// 顺序：先跑不需要HTTP服务、纯节点函数调用的，再跑需要真实HTTP接口的，
// 老架构对照放最后（跟scenario6是同一组输入，方便紧挨着对比阅读）。
const SCRIPTS = [
  { file: 'scene-both-cafeteria-takeout.js', needsServer: false, needsNetwork: false },
  { file: 'health-reaction-not-anxiety.js', needsServer: false, needsNetwork: false },
  { file: 'emotion-single-message.js', needsServer: false, needsNetwork: false },
  { file: 'comparison-medical-terms.js', needsServer: false, needsNetwork: false },
  { file: 'service-choice-after-clarification.js', needsServer: false, needsNetwork: false },
  { file: 'premature-known-slots-summary.js', needsServer: false, needsNetwork: false },
  { file: 'gibberish-typo-clarification.js', needsServer: false, needsNetwork: false },
  { file: 'scenario22-cycle-onboarding.js', needsServer: false, needsNetwork: false },
  { file: 'scenario40-browser-comments-regression.js', needsServer: false, needsNetwork: false },
  { file: 'scenario44-cafeteria-real-path-repeat.js', needsServer: true, needsNetwork: true },
  { file: 'scenario41-user-archived-flow-http.js', needsServer: true, needsNetwork: true },
  { file: 'scenario42-natural-onboarding-and-open-dish.js', needsServer: false, needsNetwork: false },
  { file: 'scenario43-food-rejection-transition.js', needsServer: false, needsNetwork: false },
  { file: 'scenario28-dish-taste-inference.js', needsServer: false, needsNetwork: false },
  { file: 'scenario29-confirmation-with-supplement.js', needsServer: false, needsNetwork: false },
  { file: 'scenario30-explicit-addition-not-correction.js', needsServer: false, needsNetwork: false },
  { file: 'scenario31-addition-real-graph.js', needsServer: false, needsNetwork: true },
  { file: 'scenario32-http-taste-flow.js', needsServer: true, needsNetwork: true },
  { file: 'scenario33-body-before-cycle.js', needsServer: false, needsNetwork: false },
  { file: 'scenario34-body-extraction-real.js', needsServer: false, needsNetwork: true },
  { file: 'scenario11-surprise-field-confirmation.js', needsServer: false, needsNetwork: false },
  { file: 'scenario4-ambiguous-number.js', needsServer: false, needsNetwork: true },
  { file: 'scenario8-scene-false-trigger.js', needsServer: false, needsNetwork: true },
  { file: 'scenario10-goal-extraction-check.js', needsServer: false, needsNetwork: true },
  { file: 'scenario15-classifier-temperature-repeat-check.js', needsServer: false, needsNetwork: true },
  { file: 'scenario1-correction.js', needsServer: false, needsNetwork: true },
  { file: 'scenario2-incidental.js', needsServer: false, needsNetwork: true },
  { file: 'scenario9-deadlock-fix.js', needsServer: false, needsNetwork: true },
  { file: 'scenario12-stale-confirmation-giveup.js', needsServer: false, needsNetwork: true },
  { file: 'scenario3-ask-budget.js', needsServer: false, needsNetwork: true },
  { file: 'scenario5-first-turn-no-fabrication.js', needsServer: false, needsNetwork: true },
  { file: 'scenario6-same-input-comparison.js', needsServer: false, needsNetwork: true },
  { file: 'scenario16-rule19-half-example-check.js', needsServer: false, needsNetwork: true },
  { file: 'scenario7-standard-9-turn.js', needsServer: true, needsNetwork: true },
  { file: 'scenario13-eventual-completion.js', needsServer: true, needsNetwork: true },
  { file: 'scenario14-long-conversation-premature-plan.js', needsServer: true, needsNetwork: true },
  { file: 'scenario17-service-choice.js', needsServer: true, needsNetwork: true },
  {
    file: path.join(BACKEND_DIR, 'manual-test-identity.js'),
    label: 'manual-test-identity.js（老架构 /api/chat-local，跟scenario6对照用）',
    needsServer: false,
    needsNetwork: true,
    absolute: true,
  },
];

async function isServerUp() {
  try {
    const res = await fetch(CHAT_LANGGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '__health_check__' }),
    });
    return res.status < 500;
  } catch (err) {
    return false;
  }
}

function runScript(scriptPath, cwd) {
  const started = Date.now();
  // 每个场景脚本头部注释里写的运行方式都是"cd backend && node ..."——
  // 有些脚本（比如老架构走的 config.js）用的是不带路径参数的裸
  // `dotenv.config()`，这个调用是按 process.cwd() 找 .env 的，不是按
  // 脚本文件自己的路径找。之前这里误把默认 cwd 设成了 manual-tests
  // 这一层目录，导致 dotenv 在错误的目录下找不到 backend/.env，
  // BAILIAN_API_KEY 读成空——不是真的环境没配置好，是这个编排脚本自己
  // 传错了子进程的工作目录。统一固定成 BACKEND_DIR，跟每个脚本自己
  // 文档里写的运行方式保持一致。
  const result = spawnSync('node', [scriptPath], {
    cwd: cwd || BACKEND_DIR,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024 * 50,
  });
  const elapsedMs = Date.now() - started;
  const output = (result.stdout || '') + (result.stderr || '');
  return {
    exitCode: result.status,
    output,
    elapsedMs,
    crashed: result.error ? result.error.message : null,
  };
}

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(MANUAL_TESTS_DIR, `regression-log-${timestamp}.txt`);
  const logChunks = [];
  const summary = [];

  const serverUp = await isServerUp();
  console.log(`HTTP服务(${CHAT_LANGGRAPH_URL})探测结果: ${serverUp ? '在线' : '未检测到，跑到需要它的脚本时会跳过'}`);

  for (const entry of SCRIPTS) {
    const label = entry.label || entry.file;
    if (entry.needsServer && !serverUp) {
      console.log(`\n跳过: ${label}（需要先在另一个终端 npm start 起服务）`);
      summary.push({ label, verdict: '跳过（服务未起）' });
      logChunks.push(`\n===== ${label} =====\n[跳过：需要先启动HTTP服务]\n`);
      continue;
    }

    console.log(`\n运行: ${label} ...`);
    const scriptPath = entry.absolute ? entry.file : path.join(MANUAL_TESTS_DIR, entry.file);
    const { exitCode, output, elapsedMs, crashed } = runScript(scriptPath);

    logChunks.push(`\n===== ${label} (耗时${elapsedMs}ms, 退出码${exitCode}) =====\n${output}\n`);

    let verdict;
    if (crashed) {
      verdict = `失败（进程本身没能跑起来: ${crashed}）`;
    } else if (exitCode !== 0) {
      verdict = '失败（脚本抛出异常，退出码非0）';
    } else if (output.includes('❌')) {
      const failCount = (output.match(/❌/g) || []).length;
      verdict = `失败（自带断言里出现${failCount}处❌）`;
    } else if (output.includes('✅')) {
      verdict = '通过（自带断言全部✅）';
    } else {
      verdict = '需要人工核对（没有自动断言，对照脚本头部注释里的预期人工检查）';
    }

    console.log(`  -> ${verdict}（耗时${elapsedMs}ms）`);
    summary.push({ label, verdict, elapsedMs });
  }

  fs.writeFileSync(logPath, logChunks.join('\n'), 'utf8');

  console.log('\n\n========== 汇总 ==========');
  summary.forEach((s) => {
    console.log(`${s.verdict.startsWith('通过') ? '✅' : s.verdict.startsWith('跳过') ? '⏭️ ' : '⚠️ '} ${s.label} —— ${s.verdict}`);
  });
  console.log(`\n完整输出已写入: ${logPath}`);
  console.log('"需要人工核对"的几个脚本，请对照各自文件头部注释里写的预期行为，人工判断实际输出是否符合。');
}

main().catch((err) => {
  console.error('跑批脚本本身出错:', err);
  process.exit(1);
});

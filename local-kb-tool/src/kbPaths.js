const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

/**
 * 从命令行参数里取出 --kb <名字> 或 --kb=<名字>，返回 { kbName, rest }。
 * rest 是去掉 --kb 相关内容之后剩下的参数（query.js 用来拼问题文本）。
 */
function parseKbArg(argv) {
  const args = [...argv];

  const flagIndex = args.indexOf('--kb');
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    const kbName = args[flagIndex + 1];
    args.splice(flagIndex, 2);
    return { kbName, rest: args };
  }

  const eqIndex = args.findIndex((a) => a.startsWith('--kb='));
  if (eqIndex !== -1) {
    const kbName = args[eqIndex].slice('--kb='.length);
    args.splice(eqIndex, 1);
    return { kbName, rest: args };
  }

  return { kbName: null, rest: args };
}

/**
 * 算出文档目录和索引目录：
 * 1. 明确设置了 KB_DOCS_DIR / KB_INDEX_DIR 环境变量的，优先用环境变量（保留原有的完全自定义能力）
 * 2. 传了 --kb <名字> 的，用 kb-docs/<名字> 和 data/index/<名字> 这个约定
 * 3. 都没有的，退回原来的默认位置 kb-docs/ 和 data/index/（兼容已有的单知识库用法）
 */
function resolveKbPaths(kbName) {
  const docsDir = process.env.KB_DOCS_DIR
    || (kbName ? path.join(ROOT_DIR, 'kb-docs', kbName) : path.join(ROOT_DIR, 'kb-docs'));

  const indexDir = process.env.KB_INDEX_DIR
    || (kbName ? path.join(ROOT_DIR, 'data', 'index', kbName) : path.join(ROOT_DIR, 'data', 'index'));

  return { docsDir, indexDir };
}

module.exports = { parseKbArg, resolveKbPaths };

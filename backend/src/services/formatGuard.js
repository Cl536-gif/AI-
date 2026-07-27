// 通用格式违规检测 + 自动重新生成的工具模块，不跟任何具体链路绑定——
// /api/chat-local 的 localChatService.js、LangGraph 的 askNextQuestion
// 节点（以及未来的 generatePlan）都可以直接复用这一份，不用各写一份
// 检测逻辑。
//
// 背景：真实测试发现，即使完整复用 systemPrompt.js 里已经验证过的
// 规则，模型偶尔还是会违反其中几条格式类的硬性规则（比如"是……还是
// ……"排比句、逐项确认语开头）——这属于"规则堆到40多条后模型执行力
// 打折扣"的已知限制，纯靠提示词没法保证100%不出现。这个模块提供的
// 是代码层面的确定性兜底：检测到违规就带着具体问题重新生成一次，
// 而不是每次都指望模型自己记住。
const { findEnglishViolations } = require('./contentSafety');

const ACK_OPENER_PHRASES = ['收到', '记下啦', '好的记下了'];

const QUOTE_ATTRIBUTION_REGEX = /(?:你说|你刚说|听到你说|你提到)[的]?["“'']([^"”'']{2,})["”'']/g;

/**
 * 检测一段回复文本里有没有出现已知的五类违规。
 * @param {string} text 待检测的回复文本
 * @param {{ userMessages?: string[] }} options
 *   userMessages：本轮之前用户实际说过的所有原话（纯文本数组），
 *   用于判断"编造用户原话"这一类——不传的话这一类检测会被跳过。
 * @returns {Array<{ type: string, detail: string }>}
 */
function detectFormatViolations(text, { userMessages = [] } = {}) {
  const violations = [];

  const trimmed = text.trim();
  const ackHit = ACK_OPENER_PHRASES.find((phrase) => trimmed.startsWith(phrase));
  if (ackHit) {
    violations.push({ type: 'ack_opener', detail: ackHit });
  }

  if (
    /是[^。！？!?]*[，,][^。！？!?]*还是[^？?]*[？?]/.test(text) ||
    /比如[^。！？!?]*还是[^？?]*[？?]/.test(text)
  ) {
    violations.push({ type: 'parallel_question', detail: '"是……还是……"/"比如……还是……"排比反问句式' });
  }

  if (/\*\*[^*]+\*\*/.test(text)) {
    violations.push({ type: 'markdown_bold', detail: 'markdown加粗 **文字**' });
  }

  if (/^\s*[-•]\s+/m.test(text) || /^\s*\d+[.、)]\s+/m.test(text)) {
    violations.push({ type: 'list_marker', detail: '分点列表符号（-、•、数字编号）' });
  }

  const englishHits = findEnglishViolations(text);
  if (englishHits.length > 0) {
    violations.push({ type: 'english_letters', detail: englishHits.join('、') });
  }

  if (userMessages.length > 0) {
    const combinedUserText = userMessages.join('\n');
    let match;
    // eslint-disable-next-line no-cond-assign
    while ((match = QUOTE_ATTRIBUTION_REGEX.exec(text))) {
      const quoted = match[1];
      if (!combinedUserText.includes(quoted)) {
        violations.push({ type: 'fabricated_quote', detail: quoted });
      }
    }
    QUOTE_ATTRIBUTION_REGEX.lastIndex = 0; // 重置正则的全局匹配状态，避免污染下一次调用
  }

  return violations;
}

function buildRetryInstruction(violations) {
  const parts = violations
    .map((v) => {
      switch (v.type) {
        case 'ack_opener':
          return `不要用"${v.detail}"这类逐项确认语开头，直接接着说下去就好`;
        case 'parallel_question':
          return '不要使用"是……还是……"这类排比反问句式，改成陈述句或者只问一个具体问题';
        case 'markdown_bold':
          return '不要使用markdown加粗（**文字**），换成普通文字';
        case 'list_marker':
          return '不要使用分点列表符号（-、•、数字编号），改成自然口语化的连续句子';
        case 'english_letters':
          return `不要出现英文字母（上一次生成里检测到: ${v.detail}），全部换成对应的中文说法`;
        case 'fabricated_quote':
          return `不要用引号编造用户没说过的话（上一次生成里检测到疑似编造: "${v.detail}"），只有用户真实说过的原话才能用引号引用`;
        default:
          return null;
      }
    })
    .filter(Boolean);

  return `上一次生成的内容有以下问题，请重新生成一遍，务必修正：\n${parts
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n')}`;
}

/**
 * 重试耗尽后的最终确定性修复：只处理能安全用字符串操作修的两类——
 * ack_opener（直接切掉开头那个短语）和 parallel_question（把"是X，
 * 还是Y？"的逗号去掉、合并成一句连读问句，比如"是食堂还是点外卖呀？"，
 * 这跟真实测试里模型自己有时会自然生成的、不违规的表达方式是一致的）。
 * 其余三类（markdown/英文字母/编造原话）不做字符串强行处理，避免破坏
 * 语义或拼出读不通的句子——这几类如果重试耗尽仍然违规，只能原样返回
 * 连同 violations 一起交给调用方处理。
 */
function applyLastResortFix(text, violations) {
  let fixed = text;

  if (violations.some((v) => v.type === 'ack_opener')) {
    ACK_OPENER_PHRASES.forEach((phrase) => {
      const re = new RegExp(`^\\s*${phrase}[，,、]?\\s*`);
      fixed = fixed.replace(re, '');
    });
  }

  if (violations.some((v) => v.type === 'parallel_question')) {
    fixed = fixed.replace(/是([^，,？?。！\n]+)[，,]\s*(还是[^？?\n]+[？?])/g, '是$1$2');
  }

  return fixed;
}

/**
 * 带格式兜底检测的生成流程：调用方提供一个 generate(retryInstruction) 函数
 * 自己负责怎么拼提示词、怎么调模型，这个模块只负责"生成完检测一遍，有
 * 问题就把具体违规告诉调用方、让它带着这个说明再生成一次"，不关心调用方
 * 具体是哪条链路、提示词长什么样，保持通用性。
 *
 * @param {object} options
 * @param {(retryInstruction: string|null) => Promise<string>} options.generate
 *   第一次调用时 retryInstruction 是 null；如果命中违规，后续调用会带上
 *   一段说明具体问题的文字，调用方需要把这段文字带进自己的提示词里再生成。
 * @param {string[]} [options.userMessages] 供"编造用户原话"检测用
 * @param {number} [options.maxRetries] 最多重试几次（不含第一次），默认2
 * @returns {Promise<{ text: string, violations: Array, attempts: number }>}
 */
async function generateWithFormatGuard({ generate, userMessages = [], maxRetries = 2 }) {
  let retryInstruction = null;
  let lastText = '';
  let lastViolations = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const text = await generate(retryInstruction);
    const violations = detectFormatViolations(text, { userMessages });

    if (process.env.FORMAT_GUARD_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `[formatGuard] 第${attempt + 1}次生成${violations.length === 0 ? '通过' : '命中违规: ' + violations.map((v) => v.type).join(', ')}`
      );
      // eslint-disable-next-line no-console
      console.log(`[formatGuard] 第${attempt + 1}次生成的完整文本:`, text);
    }

    if (violations.length === 0) {
      return { text, violations: [], attempts: attempt + 1 };
    }

    lastText = text;
    lastViolations = violations;
    retryInstruction = buildRetryInstruction(violations);
  }

  // 超过重试上限仍有违规：先尝试确定性字符串修复（只覆盖 ack_opener
  // 和 parallel_question 这两类能安全处理的），修复后重新检测一遍；
  // 如果违规确实减少了就用修复后的版本，否则原样返回，不能无限重试。
  const fixedText = applyLastResortFix(lastText, lastViolations);
  const fixedViolations = detectFormatViolations(fixedText, { userMessages });

  if (process.env.FORMAT_GUARD_DEBUG && fixedText !== lastText) {
    // eslint-disable-next-line no-console
    console.log('[formatGuard] 重试耗尽，尝试字符串级最终修复:', fixedText);
    // eslint-disable-next-line no-console
    console.log(
      '[formatGuard] 修复后剩余违规:',
      fixedViolations.length === 0 ? '无' : fixedViolations.map((v) => v.type).join(', ')
    );
  }

  if (fixedViolations.length < lastViolations.length) {
    return { text: fixedText, violations: fixedViolations, attempts: maxRetries + 1, autoFixed: true };
  }

  return { text: lastText, violations: lastViolations, attempts: maxRetries + 1, autoFixed: false };
}

module.exports = { detectFormatViolations, generateWithFormatGuard };

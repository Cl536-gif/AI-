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

// 跟 manual-tests/scenario3-ask-budget.js 里已经验证过的检测范围保持
// 一致，不重新发明一套。systemPrompt.js第13/16条明确禁止emoji装饰，
// 但这条规则之前只存在于提示词文字描述里，从没被这个模块纳入代码层面
// 检测——真实测试里在/api/chat-local的回复里撞见过一次emoji，说明
// 光靠提示词描述并不总是可靠，需要跟排比句、加粗这些其它四类一样，
// 补上代码层面的确定性检测。
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

// 排查了一遍 systemPrompt.js 全部规则，找出跟emoji同一类"只写在提示词
// 文字描述里、从没被这个模块纳入代码检测"的硬性、可机械判断的格式类
// 规则，这两条也补上：
// - 第13条禁止"标题"这类文档化排版——markdown标题（# ## ###）之前
//   完全没检测，只查了加粗和分点列表。
// - 第28条明确禁止称呼词"乖乖"——是个具体的禁用词，可以直接字符串
//   匹配，不需要语义判断。
const MARKDOWN_HEADING_REGEX = /^#{1,6}\s+\S/m;
const BANNED_ADDRESS_TERMS = ['乖乖'];

/**
 * 检测一段回复文本里有没有出现已知的八类违规。
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

  if (MARKDOWN_HEADING_REGEX.test(text)) {
    violations.push({ type: 'markdown_heading', detail: 'markdown标题（# ## ###）' });
  }

  const bannedTermHit = BANNED_ADDRESS_TERMS.find((term) => text.includes(term));
  if (bannedTermHit) {
    violations.push({ type: 'banned_address_term', detail: bannedTermHit });
  }

  const englishHits = findEnglishViolations(text);
  if (englishHits.length > 0) {
    violations.push({ type: 'english_letters', detail: englishHits.join('、') });
  }

  if (EMOJI_REGEX.test(text)) {
    violations.push({ type: 'emoji', detail: '出现了emoji表情符号' });
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
        case 'markdown_heading':
          return '不要使用markdown标题（# ## ###），改成自然口语化的连续句子，不要分段加小标题';
        case 'banned_address_term':
          return `不要使用"${v.detail}"这个称呼，换成不称呼或者用"宝子""闺蜜"这类允许的称呼`;
        case 'english_letters':
          return `不要出现英文字母（上一次生成里检测到: ${v.detail}），全部换成对应的中文说法`;
        case 'emoji':
          return '不要使用任何emoji表情符号装饰，改成纯文字表达语气';
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
 * 重试耗尽后的最终确定性修复：只处理能安全用字符串操作修的七类——
 * ack_opener（直接切掉开头那个短语）、parallel_question（把"是X，
 * 还是Y？"的逗号去掉、合并成一句连读问句，比如"是食堂还是点外卖呀？"，
 * 这跟真实测试里模型自己有时会自然生成的、不违规的表达方式是一致的）、
 * emoji（直接删掉emoji字符本身）、markdown_heading（去掉行首的#号，
 * 标题下面的文字本身通常还是通顺的）、banned_address_term（直接删掉
 * 禁用称呼词本身）、markdown_bold（去掉**符号本身，保留中间的文字——
 * 这跟parallel_question的思路一致：只拆掉"标记符号"，被标记的内容
 * 原样保留，不会读不通）、list_marker（去掉每行行首的-/•/数字编号，
 * 这几类删除后都不会破坏句子结构，只需要顺手清理删除后可能留下的多余
 * 空格。
 * 其余一类（英文字母/编造原话/学术数据这几类如果以后加入检测）不做
 * 字符串强行处理，避免破坏语义或拼出读不通的句子——这几类如果重试
 * 耗尽仍然违规，只能原样返回连同 violations 一起交给调用方处理。
 *
 * 注意：这个函数只负责清理"标记符号"本身，不负责判断被标记的内容
 * 是否完整——比如重试过程中模型为了消除格式违规把方案正文删掉、只
 * 剩确认语这种"内容缺失"问题，不属于这个函数的职责范围，需要调用方
 * 另外检查。
 */
function applyLastResortFix(text, violations) {
  let fixed = text;

  if (violations.some((v) => v.type === 'ack_opener')) {
    ACK_OPENER_PHRASES.forEach((phrase) => {
      // 字符类之前只认逗号/顿号，模型偶尔会用"收到！"这类感叹号/波浪号
      // 结尾，没被这个字符类覆盖到的话，开头词删掉后感叹号会原样留在
      // 最前面，变成读不通的"！已经..."——这是真实测试撞见过的bug。
      const re = new RegExp(`^\\s*${phrase}[，,、！!～~]?\\s*`);
      fixed = fixed.replace(re, '');
    });
  }

  if (violations.some((v) => v.type === 'parallel_question')) {
    fixed = fixed.replace(/是([^，,？?。！\n]+)[，,]\s*(还是[^？?\n]+[？?])/g, '是$1$2');
  }

  if (violations.some((v) => v.type === 'markdown_bold')) {
    fixed = fixed.replace(/\*\*([^*]+)\*\*/g, '$1');
  }

  if (violations.some((v) => v.type === 'list_marker')) {
    fixed = fixed.replace(/^\s*[-•]\s+/gm, '').replace(/^\s*\d+[.、)]\s+/gm, '');
  }

  if (violations.some((v) => v.type === 'emoji')) {
    fixed = fixed.replace(new RegExp(EMOJI_REGEX.source, 'gu'), '');
  }

  if (violations.some((v) => v.type === 'markdown_heading')) {
    fixed = fixed.replace(/^#{1,6}\s+/gm, '');
  }

  if (violations.some((v) => v.type === 'banned_address_term')) {
    BANNED_ADDRESS_TERMS.forEach((term) => {
      fixed = fixed.split(term).join('');
    });
  }

  fixed = fixed.replace(/[ \t]{2,}/g, ' '); // 清理上面几类删除操作可能留下的连续空格

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

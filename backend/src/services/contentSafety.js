const ALLOWED_TERMS = ['AI秘书'];
const ENGLISH_RUN_REGEX = /[A-Za-z]{2,}/g;

function placeholderFor(index) {
  // 占位符本身不能含连续英文字母，否则会被自己的检测规则误伤
  return `〔占位${index}〕`;
}

function maskAllowedTerms(text) {
  const placeholders = [];
  let masked = text;
  ALLOWED_TERMS.forEach((term, i) => {
    if (!masked.includes(term)) return;
    const token = placeholderFor(i);
    masked = masked.split(term).join(token);
    placeholders.push({ token, term });
  });
  return { masked, placeholders };
}

function restoreAllowedTerms(text, placeholders) {
  return placeholders.reduce((acc, { token, term }) => acc.split(token).join(term), text);
}

/** 找出回复文本里除允许词以外的连续英文字母片段 */
function findEnglishViolations(text) {
  const { masked } = maskAllowedTerms(text);
  return masked.match(ENGLISH_RUN_REGEX) || [];
}

/** 简单替换处理：把违规的英文片段直接去掉，允许词保留 */
function sanitize(text) {
  const { masked, placeholders } = maskAllowedTerms(text);
  const cleaned = masked.replace(ENGLISH_RUN_REGEX, '');
  return restoreAllowedTerms(cleaned, placeholders);
}

module.exports = { findEnglishViolations, sanitize };

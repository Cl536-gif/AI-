require('dotenv').config();

const DEFAULT_KEYWORDS = [
  'female college students weight management',
  'young women dietary intervention',
  'spot reduction adipose tissue',
  'regional fat loss exercise',
  'BMI body composition young adults',
  'disordered eating prevention diet coaching',
  'normal-weight obesity',
  'hidden obesity',
  'female weight management',
  'diet',
  'eating behavior',
];

function parseKeywords() {
  if (!process.env.PUBMED_KEYWORDS) return DEFAULT_KEYWORDS;
  return process.env.PUBMED_KEYWORDS.split('|')
    .map((k) => k.trim())
    .filter(Boolean);
}

const CURRENT_YEAR = new Date().getFullYear();

module.exports = {
  keywords: parseKeywords(),
  resultsPerKeyword: Number(process.env.PUBMED_RESULTS_PER_KEYWORD) || 15,
  apiKey: process.env.PUBMED_API_KEY || '',
  email: process.env.PUBMED_EMAIL || '',
  toolName: process.env.PUBMED_TOOL_NAME || 'pubmed-tool',
  minYear: Number(process.env.PUBMED_MIN_YEAR) || CURRENT_YEAR - (Number(process.env.PUBMED_MAX_AGE_YEARS) || 15),
  minAbstractLength: Number(process.env.PUBMED_MIN_ABSTRACT_LENGTH) || 200,
  outputDir: process.env.PUBMED_OUTPUT_DIR || 'candidates',

  // 每周增量更新
  weeklyDays: Number(process.env.PUBMED_WEEKLY_DAYS) || 7,
  processedStoreFile: process.env.PUBMED_PROCESSED_STORE || 'data/processed-pmids.json',

  // AI 辅助打分（阿里云百炼通用模型接口，不是 backend/ 里那个绑定了人设知识库的应用）
  bailianApiKey: process.env.BAILIAN_API_KEY || '',
  bailianBaseUrl: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  bailianModel: process.env.BAILIAN_MODEL || 'qwen-plus',
  aiScorerDelayMs: Number(process.env.AI_SCORER_DELAY_MS) || 300,
};

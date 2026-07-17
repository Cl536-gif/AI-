require('dotenv').config();

const DEFAULT_KEYWORDS = [
  'female college students weight management',
  'young women dietary intervention',
  'spot reduction myth localized fat loss',
  'BMI body composition young adults',
  'disordered eating prevention diet coaching',
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
};

const { XMLParser } = require('fast-xml-parser');
const config = require('./config');

const BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
// 未注册 API Key 时 NCBI 限速约 3 次/秒，注册后约 10 次/秒；这里留一点余量
const REQUEST_DELAY_MS = config.apiKey ? 120 : 350;
const EFETCH_BATCH_SIZE = 100;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCommonParams() {
  const params = new URLSearchParams();
  if (config.apiKey) params.set('api_key', config.apiKey);
  if (config.email) params.set('email', config.email);
  if (config.toolName) params.set('tool', config.toolName);
  return params;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * 部分网络环境下 NCBI 连接会被中间设备偶发重置（ECONNRESET），
 * 单次失败就让整个脚本中断代价太大，这里做几次重试再放弃。
 */
async function eutilsRequest(endpoint, params) {
  const url = `${BASE_URL}/${endpoint}?${params.toString()}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`PubMed ${endpoint} 请求失败: HTTP ${response.status}`);
      }
      return response;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.log(`  请求失败（第 ${attempt} 次，${err.message}），${RETRY_DELAY_MS / 1000} 秒后重试...`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error('unreachable');
}

/**
 * 用一个关键词检索，返回匹配到的 PMID 列表。
 * 传 days 时只检索最近 N 天内新发表的文献（用于每周增量更新）。
 */
async function searchPmids(keyword, { days } = {}) {
  const params = buildCommonParams();
  params.set('db', 'pubmed');
  params.set('term', keyword);
  params.set('retmax', String(config.resultsPerKeyword));
  params.set('retmode', 'json');
  params.set('sort', 'pub+date');

  if (days) {
    params.set('datetype', 'pdat');
    params.set('reldate', String(days));
  }

  const response = await eutilsRequest('esearch.fcgi', params);
  const data = await response.json();
  return data?.esearchresult?.idlist || [];
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

const NAMED_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * 部分 PubMed 记录里的特殊字符（重音字母、数学符号等）不是标准 XML 转义，
 * 而是以 HTML 数字实体的字面文本形式存在（比如 "&#xe8;"、"&#x2265;"），
 * XML 解析库不会处理这种情况，需要单独解码一次。
 */
function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => NAMED_HTML_ENTITIES[name]);
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return decodeHtmlEntities(String(node));
  if (typeof node === 'object' && '#text' in node) return decodeHtmlEntities(String(node['#text']));
  return '';
}

function extractAbstract(article) {
  const abstractNode = article?.Abstract?.AbstractText;
  if (!abstractNode) return '';
  return asArray(abstractNode)
    .map((piece) => {
      const label = piece?.['@_Label'];
      const text = textOf(piece);
      return label ? `${label}: ${text}` : text;
    })
    .join('\n');
}

function extractAuthors(article) {
  const authorNode = article?.AuthorList?.Author;
  if (!authorNode) return [];
  return asArray(authorNode).map((author) => {
    if (author?.CollectiveName) return textOf(author.CollectiveName);
    const last = textOf(author?.LastName);
    const initials = textOf(author?.Initials);
    return [last, initials].filter(Boolean).join(' ');
  }).filter(Boolean);
}

function extractYear(article) {
  const pubDate = article?.Journal?.JournalIssue?.PubDate;
  const year = textOf(pubDate?.Year);
  if (year) return Number(year);
  // 部分记录没有结构化 Year，只有 MedlineDate 这种自由文本（如 "2019 Jan-Feb"）
  const medlineDate = textOf(pubDate?.MedlineDate);
  const match = medlineDate.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function parseArticleXml(xml) {
  const parsed = xmlParser.parse(xml);
  const rawArticles = asArray(parsed?.PubmedArticleSet?.PubmedArticle);

  return rawArticles.map((entry) => {
    const citation = entry.MedlineCitation;
    const article = citation?.Article;
    const pmid = textOf(citation?.PMID);

    return {
      pmid,
      title: textOf(article?.ArticleTitle),
      abstract: extractAbstract(article),
      authors: extractAuthors(article),
      journal: textOf(article?.Journal?.Title) || textOf(article?.Journal?.ISOAbbreviation),
      year: extractYear(article),
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '',
    };
  });
}

/** 批量抓取一组 PMID 对应的标题/摘要/作者/期刊/年份等元数据 */
async function fetchArticles(pmids) {
  const articles = [];

  for (let i = 0; i < pmids.length; i += EFETCH_BATCH_SIZE) {
    const batch = pmids.slice(i, i + EFETCH_BATCH_SIZE);
    const params = buildCommonParams();
    params.set('db', 'pubmed');
    params.set('id', batch.join(','));
    params.set('rettype', 'abstract');
    params.set('retmode', 'xml');

    const response = await eutilsRequest('efetch.fcgi', params);
    const xml = await response.text();
    articles.push(...parseArticleXml(xml));

    if (i + EFETCH_BATCH_SIZE < pmids.length) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return articles;
}

module.exports = { searchPmids, fetchArticles, parseArticleXml, decodeHtmlEntities, sleep, REQUEST_DELAY_MS };

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

async function eutilsRequest(endpoint, params) {
  const url = `${BASE_URL}/${endpoint}?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`PubMed ${endpoint} 请求失败: HTTP ${response.status}`);
  }
  return response;
}

/** 用一个关键词检索，返回匹配到的 PMID 列表 */
async function searchPmids(keyword) {
  const params = buildCommonParams();
  params.set('db', 'pubmed');
  params.set('term', keyword);
  params.set('retmax', String(config.resultsPerKeyword));
  params.set('retmode', 'json');
  params.set('sort', 'pub+date');

  const response = await eutilsRequest('esearch.fcgi', params);
  const data = await response.json();
  return data?.esearchresult?.idlist || [];
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
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

module.exports = { searchPmids, fetchArticles, parseArticleXml, sleep, REQUEST_DELAY_MS };

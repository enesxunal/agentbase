import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { extractRichTextClaims } from "./rich_extraction.js";
import { extractClaimsWithLlm, llmExtractionConfigured } from "./llm_extraction.js";

export type CrawledDocument = {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  contentType: string | null;
  httpStatus: number;
  etag: string | null;
  lastModified: string | null;
  bodyHash: string;
  rawText: string;
  jsonld: unknown[];
  metadata: Record<string, unknown>;
};

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function collectLabeledPairs($: cheerio.CheerioAPI) {
  const pairs: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string) => {
    const l = normalizeText(label).slice(0, 80);
    const v = normalizeText(value).slice(0, 300);
    if (!l || !v || l === v) return;
    pairs.push({ label: l, value: v });
  };

  $('tr').each((_, row) => {
    const cells = $(row).find('th,td').toArray().map((cell) => normalizeText($(cell).text())).filter(Boolean);
    if (cells.length >= 2) push(cells[0], cells.slice(1).join(' '));
  });
  $('dt').each((_, dt) => {
    const dd = $(dt).next('dd');
    if (dd.length) push($(dt).text(), dd.text());
  });
  $('[itemprop]').each((_, el) => {
    const label = $(el).attr('itemprop') || '';
    const value = $(el).attr('content') || $(el).attr('href') || $(el).text();
    push(label, value);
  });

  const seen = new Set<string>();
  return pairs.filter((pair) => {
    const key = `${pair.label.toLocaleLowerCase('tr-TR')}|${pair.value.toLocaleLowerCase('tr-TR')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);
}

function parseJsonLd($: cheerio.CheerioAPI) {
  const values: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) values.push(...parsed);
      else values.push(parsed);
    } catch {
      // Invalid JSON-LD is ignored but page ingestion continues.
    }
  });
  return values;
}

export async function crawlUrl(url: string): Promise<CrawledDocument> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported_protocol');

  const response = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: {
      'user-agent': 'AgentBaseBot/0.1 (+https://agentbase.com.tr/bot)',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5'
    },
    signal: AbortSignal.timeout(15000)
  });

  const contentType = response.headers.get('content-type');
  const body = await response.text();
  const bodyHash = createHash('sha256').update(body).digest('hex');

  if (contentType?.includes('application/json')) {
    let parsedJson: unknown = null;
    try { parsedJson = JSON.parse(body); } catch {}
    return {
      url: response.url,
      canonicalUrl: response.url,
      title: null,
      description: null,
      contentType,
      httpStatus: response.status,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      bodyHash,
      rawText: body.slice(0, 250000),
      jsonld: [],
      metadata: { json: parsedJson }
    };
  }

  const $ = cheerio.load(body);
  $('script:not([type="application/ld+json"]),style,noscript,svg').remove();
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const resolvedCanonical = canonical ? new URL(canonical, response.url).toString() : response.url;
  const title = normalizeText($('title').first().text()) || null;
  const description = $('meta[name="description"]').attr('content')?.trim() || null;
  const rawText = normalizeText($('main').text() || $('article').text() || $('body').text()).slice(0, 250000);
  const jsonld = parseJsonLd($);
  const metadata = {
    language: $('html').attr('lang') || null,
    h1: normalizeText($('h1').first().text()) || null,
    ogTitle: $('meta[property="og:title"]').attr('content') || null,
    ogDescription: $('meta[property="og:description"]').attr('content') || null,
    ogType: $('meta[property="og:type"]').attr('content') || null,
    labeledPairs: collectLabeledPairs($)
  };

  return {
    url: response.url,
    canonicalUrl: resolvedCanonical,
    title,
    description,
    contentType,
    httpStatus: response.status,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    bodyHash,
    rawText,
    jsonld,
    metadata
  };
}

function derivePageSubjectName(document: CrawledDocument) {
  const h1 = typeof document.metadata?.h1 === 'string' ? String(document.metadata.h1).trim() : '';
  if (h1 && h1.length <= 160) return h1;
  if (!document.title) return null;
  const parts = document.title.split(/\s+[|–—-]\s+/).map((part) => part.trim()).filter(Boolean);
  return (parts[0] || document.title).slice(0,160);
}

export function extractClaims(document: CrawledDocument) {
  const claims: Array<{ subjectName: string | null; subjectType?: string | null; predicate: string; value: unknown; confidence: number; evidence?: string }> = [];
  const pageSubjectName = derivePageSubjectName(document);

  for (const node of document.jsonld) {
    const items = typeof node === 'object' && node && '@graph' in (node as Record<string, unknown>)
      ? ((node as Record<string, unknown>)['@graph'] as unknown[] ?? [])
      : [node];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const subjectName = typeof record.name === 'string' ? record.name : document.title;
      const rawType = record['@type'];
      const subjectType = Array.isArray(rawType) ? String(rawType[0] ?? '') || null : typeof rawType === 'string' ? rawType : null;
      for (const key of ['name', 'description', 'address', 'telephone', 'email', 'url', 'openingHours', 'openingHoursSpecification', 'servesCuisine', 'priceRange', 'paymentAccepted', 'currenciesAccepted', 'geo', 'latitude', 'longitude', 'sameAs', 'amenityFeature', 'foundingDate', 'startDate', 'endDate', 'eventStatus', 'location']) {
        if (record[key] === undefined) continue;
        claims.push({
          subjectName,
          subjectType,
          predicate: `schema:${key}`,
          value: record[key],
          confidence: 0.9,
          evidence: 'JSON-LD'
        });
      }
    }
  }

  if (document.title) claims.push({ subjectName: pageSubjectName, predicate: 'page:title', value: document.title, confidence: 0.75, evidence: 'HTML title' });
  if (document.description) claims.push({ subjectName: pageSubjectName, predicate: 'page:description', value: document.description, confidence: 0.7, evidence: 'meta description' });

  const inferredSubjectType = claims.find((claim) => claim.subjectName === pageSubjectName && claim.subjectType)?.subjectType ?? null;
  claims.push(...extractRichTextClaims({ rawText: document.rawText, metadata: document.metadata, subjectName: pageSubjectName, subjectType: inferredSubjectType }));

  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.subjectName ?? ''}|${claim.predicate}|${JSON.stringify(claim.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 250);
}

export async function extractClaimsAsync(document: CrawledDocument) {
  const deterministic = extractClaims(document);
  if (!llmExtractionConfigured()) return deterministic;
  const pageSubjectName = derivePageSubjectName(document);
  const inferredSubjectType = deterministic.find((claim) => claim.subjectName === pageSubjectName && claim.subjectType)?.subjectType ?? null;
  let llmClaims: Awaited<ReturnType<typeof extractClaimsWithLlm>> = [];
  try {
    llmClaims = await extractClaimsWithLlm({ rawText: document.rawText, subjectName: pageSubjectName, subjectType: inferredSubjectType });
  } catch {
    llmClaims = [];
  }
  const seen = new Set<string>();
  return [...deterministic, ...llmClaims].filter((claim) => {
    const key = `${claim.subjectName ?? ''}|${claim.predicate}|${JSON.stringify(claim.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 300);
}

export async function robotsAllows(url: string, userAgent = 'AgentBaseBot') {
  const target = new URL(url);
  const robotsUrl = new URL('/robots.txt', target.origin).toString();
  try {
    const response = await fetch(robotsUrl, { headers: { 'user-agent': `${userAgent}/0.1 (+https://agentbase.com.tr/bot)` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { allowed: true, robotsUrl, reason: 'robots_unavailable' };
    const text = await response.text();
    const lines = text.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
    let applies = false;
    const disallow: string[] = [];
    const allow: string[] = [];
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === 'user-agent') {
        const ua = value.toLowerCase();
        applies = ua === '*' || ua.includes(userAgent.toLowerCase());
        continue;
      }
      if (!applies) continue;
      if (key === 'disallow' && value) disallow.push(value);
      if (key === 'allow' && value) allow.push(value);
    }
    const path = target.pathname || '/';
    const matchingAllow = allow.filter((rule) => path.startsWith(rule)).sort((a,b)=>b.length-a.length)[0];
    const matchingDeny = disallow.filter((rule) => path.startsWith(rule)).sort((a,b)=>b.length-a.length)[0];
    const allowed = !matchingDeny || Boolean(matchingAllow && matchingAllow.length >= matchingDeny.length);
    return { allowed, robotsUrl, reason: allowed ? 'allowed' : `disallowed:${matchingDeny}` };
  } catch {
    return { allowed: true, robotsUrl, reason: 'robots_fetch_failed' };
  }
}

export async function discoverSameOriginLinks(url: string, maxLinks = 100) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'AgentBaseBot/0.1 (+https://agentbase.com.tr/bot)', accept: 'text/html,*/*;q=0.5' },
    signal: AbortSignal.timeout(15000)
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return [] as string[];
  const body = await response.text();
  const $ = cheerio.load(body);
  const origin = new URL(response.url).origin;
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    try {
      const resolved = new URL(href, response.url);
      if (resolved.origin !== origin || !['http:','https:'].includes(resolved.protocol)) return;
      resolved.hash = '';
      if (/\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|mp4|mp3)$/i.test(resolved.pathname)) return;
      out.add(resolved.toString());
    } catch {}
  });
  return [...out].slice(0, Math.max(1, Math.min(500, maxLinks)));
}

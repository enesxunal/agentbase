import os from 'node:os';
import process from 'node:process';
import {
  claimBackgroundJobDb,
  completeBackgroundJobDb,
  failBackgroundJobDb,
  getSourceRegistryDb,
  claimSourceFrontierBatchDb,
  finishSourceFrontierDb,
  upsertSourceDocumentDb,
  replaceExtractedClaimsDb,
  resolveClaimEntityDb,
  enqueueSourceUrlDb,
  markSourceRegistryCrawledDb,
  markSourceRegistryRefreshFailedDb,
  prepareSourceRefreshDb,
  enqueueDueSourceRefreshJobsDb,
  autoCreateEntitiesDb,
  autoReviewPendingClaimsDb,
  createAgentEventDb,
  refreshAllEntityEmbeddingsDb,
  setIngestionJobRunningDb,
  finishIngestionJobDb,
  upsertBusinessDiscoveryCandidateDb,
  createBusinessDiscoveryRunDb,
  registerBusinessWebsiteSourcesDb,
  enqueueDueBusinessDiscoveryJobDb
} from './db.js';
import { crawlUrl, extractClaimsAsync, robotsAllows, discoverSameOriginLinks } from './ingestion.js';
import { safeFetchText } from './fetch_security.js';

const WORKER_ID = process.env.AGENTBASE_WORKER_ID || `${os.hostname()}:${process.pid}`;
const POLL_MS = Math.max(500, Number(process.env.WORKER_POLL_MS || 1500));
let stopping = false;

function dateInIstanbul(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function ensureRollingSourceSeeds(source: { id: string; baseUrl: string; metadata?: Record<string, unknown> }) {
  const days = Number(source.metadata?.rollingDateWindowDays ?? 0);
  if (!Number.isFinite(days) || days <= 0) return;
  const url = new URL(source.baseUrl);
  url.searchParams.set('start_date', dateInIstanbul(0));
  url.searchParams.set('end_date', dateInIstanbul(Math.min(365, Math.max(1, Math.round(days)))));
  await enqueueSourceUrlDb(source.id, url.toString(), 0);
}

type CrawlMetadata = {
  allowedPathPrefixes?: string[];
  deniedPathPrefixes?: string[];
  allowedQueryKeys?: string[];
  crawlProfile?: string;
};

function normalizeDiscoveredUrl(rawUrl: string, metadata: CrawlMetadata) {
  const url = new URL(rawUrl);
  if (metadata.allowedPathPrefixes?.length && !metadata.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return null;
  if (metadata.deniedPathPrefixes?.some((prefix) => url.pathname.startsWith(prefix))) return null;
  if (metadata.allowedQueryKeys?.length) {
    for (const key of [...url.searchParams.keys()]) {
      if (!metadata.allowedQueryKeys.includes(key)) url.searchParams.delete(key);
    }
  }
  if (metadata.crawlProfile === 'ibb-culture-events-current-v2') {
    const isDetail = /^\/etkinliklerimiz\/\d+\//.test(url.pathname);
    const isWindowPage = url.pathname === '/etkinliklerimiz/ara' && url.searchParams.has('start_date') && url.searchParams.has('end_date');
    if (!isDetail && !isWindowPage) return null;
  }
  url.hash = '';
  return url.toString();
}

async function runSourceRegistry(sourceId: string) {
  const source = await getSourceRegistryDb(sourceId);
  if (!source) throw new Error('source_registry_not_found');
  if (!source.crawlEnabled) return { sourceId, processed: 0, completed: 0, failed: 0, blocked: 0, discovered: 0, skipped: true };

  await ensureRollingSourceSeeds(source);
  await prepareSourceRefreshDb(sourceId);
  const batch = await claimSourceFrontierBatchDb(sourceId, source.maxPagesPerRun);
  const stats = { sourceId, processed: batch.length, completed: 0, failed: 0, blocked: 0, discovered: 0 };
  const sourceOrigin = new URL(source.baseUrl).origin;
  const crawlMetadata = (source.metadata ?? {}) as CrawlMetadata;

  for (const item of batch) {
    try {
      const target = new URL(item.url);
      if (target.origin !== sourceOrigin) {
        await finishSourceFrontierDb(item.id, 'blocked', 'cross_origin');
        stats.blocked++;
        continue;
      }
      if (source.respectRobots) {
        const robots = await robotsAllows(item.url);
        if (!robots.allowed) {
          await finishSourceFrontierDb(item.id, 'blocked', robots.reason);
          stats.blocked++;
          continue;
        }
      }
      const crawled = await crawlUrl(item.url);
      const document = await upsertSourceDocumentDb({ ...crawled, sourceRegistryId: source.id });
      if (!document) throw new Error('database_required');
      const claims = await extractClaimsAsync(crawled);
      const savedClaims = await replaceExtractedClaimsDb(document.id, claims);
      for (const claim of savedClaims) await resolveClaimEntityDb(claim.id);
      if (item.depth < 2) {
        const links = await discoverSameOriginLinks(item.url, 50);
        for (const link of links) {
          const normalized = normalizeDiscoveredUrl(link, crawlMetadata);
          if (!normalized) continue;
          await enqueueSourceUrlDb(sourceId, normalized, item.depth + 1, item.url);
          stats.discovered++;
        }
      }
      await finishSourceFrontierDb(item.id, 'completed');
      stats.completed++;
    } catch (error) {
      await finishSourceFrontierDb(item.id, 'failed', error instanceof Error ? error.message.slice(0,500) : String(error).slice(0,500));
      stats.failed++;
    }
    if (source.crawlDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, source.crawlDelayMs));
  }

  await markSourceRegistryCrawledDb(sourceId);
  const autoEntities = await autoCreateEntitiesDb(sourceId, 200);
  const autoReview = await autoReviewPendingClaimsDb(sourceId, 500);
  const result = { ...stats, autoEntities, autoReview };
  await createAgentEventDb({ agentId: 'agentbase-verifier', eventType: 'source_crawl_completed', payload: { message: `${source.name} kaynağı worker tarafından tarandı`, ...stats } });
  return result;
}

function normalizeBusinessWebsite(value: unknown) {
  if (typeof value !== 'string') return null;
  let raw=value.trim();
  if (!raw) return null;
  if (/^www\./i.test(raw)) raw='https://'+raw;
  try {
    const url=new URL(raw);
    if (!['http:','https:'].includes(url.protocol)) return null;
    url.hash='';
    return url.toString();
  } catch { return null; }
}

function osmAddress(tags: Record<string, unknown>) {
  const parts=[tags['addr:street'],tags['addr:housenumber'],tags['addr:suburb'],tags['addr:district'],tags['addr:postcode'],tags['addr:city']]
    .filter((v)=>typeof v==='string' && v.trim()).map(String);
  return parts.length ? parts.join(' ') : null;
}

async function runIstanbulBusinessDiscovery(payload: Record<string, unknown>) {
  const city=String(payload.city || 'İstanbul');
  if (city !== 'İstanbul') throw new Error('business_discovery_city_not_supported_yet');
  const limit=Math.max(1,Math.min(500,Number(payload.limit || 100)));
  const endpoint=String(process.env.OSM_OVERPASS_URL || 'https://overpass-api.de/api/interpreter');
  const bbox='40.802,28.500,41.350,29.650';
  const queryLimit=Math.min(1000,limit*2);
  const query='[out:json][timeout:25];(nwr["amenity"~"^(restaurant|cafe)$"]('+bbox+'););out center tags '+queryLimit+';';
  const { response, body }=await safeFetchText(endpoint,{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded','user-agent':'AgentBaseBot/0.1 (+https://agentbase.com.tr/bot)'},
    body:'data='+encodeURIComponent(query)
  },5*1024*1024);
  if (!response.ok) throw new Error('overpass_http_'+response.status);
  const parsed=JSON.parse(body) as { elements?: Array<Record<string, unknown>> };
  const rows=Array.isArray(parsed.elements) ? parsed.elements : [];
  let discovered=0; let withWebsite=0;
  for (const element of rows) {
    if (discovered >= limit) break;
    const tags=(element.tags && typeof element.tags==='object' ? element.tags : {}) as Record<string,unknown>;
    const name=typeof tags.name==='string' ? tags.name.trim() : '';
    const amenity=tags.amenity === 'cafe' ? 'cafe' : tags.amenity === 'restaurant' ? 'restaurant' : null;
    if (!name || !amenity) continue;
    const type=String(element.type || 'node'); const id=String(element.id || '');
    if (!id) continue;
    const center=(element.center && typeof element.center==='object' ? element.center : {}) as Record<string,unknown>;
    const lat=Number(element.lat ?? center.lat); const lon=Number(element.lon ?? center.lon);
    const website=normalizeBusinessWebsite(tags.website ?? tags['contact:website']);
    if (website) withWebsite++;
    await upsertBusinessDiscoveryCandidateDb({
      provider:'openstreetmap', externalId:type+'/'+id, name, category:amenity, city,
      district:typeof tags['addr:district']==='string' ? String(tags['addr:district']) : (typeof tags['addr:suburb']==='string' ? String(tags['addr:suburb']) : null),
      website, telephone:typeof (tags.phone ?? tags['contact:phone'])==='string' ? String(tags.phone ?? tags['contact:phone']) : null,
      address:osmAddress(tags), latitude:Number.isFinite(lat)?lat:null, longitude:Number.isFinite(lon)?lon:null,
      sourceUrl:'https://www.openstreetmap.org/'+type+'/'+id, raw:{tags}
    });
    discovered++;
  }
  const registered=await registerBusinessWebsiteSourcesDb(city,limit);
  const run=await createBusinessDiscoveryRunDb({provider:'openstreetmap',city,discovered,withWebsite,details:{registeredWebsiteSources:registered.length,attribution:'© OpenStreetMap contributors',license:'ODbL'}});
  return {runId:run?.id ?? null,city,discovered,withWebsite,registeredWebsiteSources:registered.length};
}

async function execute(job: { jobType: string; payload: Record<string, unknown> }) {
  if (job.jobType === 'business_discovery') {
    return runIstanbulBusinessDiscovery(job.payload);
  }
  if (job.jobType === 'source_crawl') {
    const sourceId = String(job.payload.sourceId || '');
    if (!sourceId) throw new Error('source_id_required');
    return runSourceRegistry(sourceId);
  }
  if (job.jobType === 'ingest_url') {
    const ingestionJobId = String(job.payload.ingestionJobId || '');
    const url = String(job.payload.url || '');
    if (!ingestionJobId || !url) throw new Error('ingestion_job_id_and_url_required');
    await setIngestionJobRunningDb(ingestionJobId);
    try {
      const crawled = await crawlUrl(url);
      const document = await upsertSourceDocumentDb(crawled);
      if (!document) throw new Error('database_required');
      const claims = await extractClaimsAsync(crawled);
      const savedClaims = await replaceExtractedClaimsDb(document.id, claims);
      for (const claim of savedClaims) await resolveClaimEntityDb(claim.id);
      const result = { documentId: document.id, canonicalUrl: document.canonicalUrl, httpStatus: document.httpStatus, title: document.title, claims: claims.length, bodyHash: document.bodyHash };
      await finishIngestionJobDb(ingestionJobId, 'completed', result);
      return result;
    } catch (error) {
      await finishIngestionJobDb(ingestionJobId, 'failed', {}, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  if (job.jobType === 'refresh_embeddings') {
    return refreshAllEntityEmbeddingsDb();
  }
  throw new Error(`unsupported_job_type:${job.jobType}`);
}

async function loop() {
  console.log(`[worker] started ${WORKER_ID}`);
  let lastRefreshSweep = 0;
  while (!stopping) {
    if (Date.now() - lastRefreshSweep >= 60000) {
      try {
        const scheduled = await enqueueDueSourceRefreshJobsDb(20);
        if (scheduled.length) console.log(`[worker] scheduled ${scheduled.length} source refresh job(s)`);
        const discovery = await enqueueDueBusinessDiscoveryJobDb('İstanbul', 30);
        if (discovery) console.log(`[worker] scheduled Istanbul business discovery ${discovery.id}`);
      } catch (error) {
        console.error(`[worker] refresh scheduler error`, error);
      }
      lastRefreshSweep = Date.now();
    }
    const job = await claimBackgroundJobDb(WORKER_ID, ['business_discovery','source_crawl','ingest_url','refresh_embeddings']);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    console.log(`[worker] claimed ${job.id} ${job.jobType} attempt=${job.attempts}`);
    try {
      const result = await execute(job);
      await completeBackgroundJobDb(job.id, result);
      console.log(`[worker] completed ${job.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      const delay = Math.min(900, 15 * Math.pow(2, Math.max(0, job.attempts - 1)));
      const next = await failBackgroundJobDb(job.id, message, delay);
      if (job.jobType === 'source_crawl') {
        const sourceId = String(job.payload.sourceId || '');
        if (sourceId) await markSourceRegistryRefreshFailedDb(sourceId);
      }
      console.error(`[worker] failed ${job.id} status=${next?.status} retry_in=${delay}s`, message);
    }
  }
  console.log('[worker] stopped');
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

loop().catch((error) => {
  console.error('[worker] fatal', error);
  process.exitCode = 1;
});

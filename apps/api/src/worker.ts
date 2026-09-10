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
  autoCreateEntitiesDb,
  autoReviewPendingClaimsDb,
  createAgentEventDb,
  refreshAllEntityEmbeddingsDb,
  setIngestionJobRunningDb,
  finishIngestionJobDb
} from './db.js';
import { crawlUrl, extractClaimsAsync, robotsAllows, discoverSameOriginLinks } from './ingestion.js';

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

async function execute(job: { jobType: string; payload: Record<string, unknown> }) {
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
  while (!stopping) {
    const job = await claimBackgroundJobDb(WORKER_ID, ['source_crawl','ingest_url','refresh_embeddings']);
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

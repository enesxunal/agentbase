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

async function runSourceRegistry(sourceId: string) {
  const source = await getSourceRegistryDb(sourceId);
  if (!source) throw new Error('source_registry_not_found');
  if (!source.crawlEnabled) return { sourceId, processed: 0, completed: 0, failed: 0, blocked: 0, discovered: 0, skipped: true };

  const batch = await claimSourceFrontierBatchDb(sourceId, source.maxPagesPerRun);
  const stats = { sourceId, processed: batch.length, completed: 0, failed: 0, blocked: 0, discovered: 0 };
  const sourceOrigin = new URL(source.baseUrl).origin;

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
          await enqueueSourceUrlDb(sourceId, link, item.depth + 1, item.url);
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

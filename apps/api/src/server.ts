import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { entities, sources } from "./data.js";
import { crawlUrl, extractClaimsAsync, robotsAllows, discoverSameOriginLinks } from "./ingestion.js";
import { parseQuery } from "./retrieval.js";
import { mcpNodeHandler } from "./mcp_server.js";
import {
  authenticateAgentTokenDb,
  createAgentDb,
  createAgentEventDb,
  createAgentReviewDb,
  createAgentTokenDb,
  createContributionDb,
  dbHealth,
  getAgentDb,
  getChangesDb,
  getDbStats,
  getEntityAgentScoreDb,
  getEntityDb,
  getFactsDb,
  getRelationsDb,
  getSourcesDb,
  listAgentsDb,
  recentPublicEvents,
  searchEntitiesDb,
  createIngestionJobDb,
  setIngestionJobRunningDb,
  finishIngestionJobDb,
  getIngestionJobDb,
  upsertSourceDocumentDb,
  replaceExtractedClaimsDb,
  listExtractedClaimsDb,
  listPendingClaimsDb,
  reviewExtractedClaimDb,
  promoteAcceptedClaimToFactDb,
  recomputeFactConfidenceDb,
  recomputeEntityConfidenceDb,
  getFactConfidenceHistoryDb,
  resolveEntityCandidatesDb,
  resolveClaimEntityDb,
  addEntityAliasDb,
  listEntityAliasesDb,
  getFactHistoryDb,
  getEntityFactsAtDb,
  listKnownCitiesDb,
  hybridRetrieveDb,
  semanticHybridRetrieveDb,
  refreshAllEntityEmbeddingsDb,
  refreshEntityEmbeddingDb,
  createSourceRegistryDb,
  listSourceRegistryDb,
  getSourceRegistryDb,
  enqueueSourceUrlDb,
  claimSourceFrontierBatchDb,
  finishSourceFrontierDb,
  markSourceRegistryCrawledDb,
  autoReviewPendingClaimsDb,
  listAutoReviewRunsDb,
  autoCreateEntitiesDb,
  listEntityCreationAuditDb,
  listAgentTokensDb,
  revokeAgentTokenDb,
  createManagedAgentTokenDb,
  rotateAgentTokenDb,
  enqueueBackgroundJobDb,
  getBackgroundJobDb,
  listBackgroundJobsDb
} from "./db.js";

const app = Fastify({
  logger: true,
  bodyLimit: Number(process.env.API_BODY_LIMIT_BYTES || 1024 * 1024),
  trustProxy: process.env.TRUST_PROXY === 'true'
});
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
await app.register(cors, {
  origin: process.env.NODE_ENV === 'production' ? corsOrigins : true,
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['content-type','authorization','mcp-protocol-version','mcp-method']
});
await app.register(rateLimit, {
  global: true,
  max: Number(process.env.GLOBAL_RATE_LIMIT_PER_MINUTE || 300),
  timeWindow: "1 minute",
  allowList: (request) => process.env.NODE_ENV !== "production" && ["127.0.0.1", "::1"].includes(request.ip),
  errorResponseBuilder: (_request, context) => ({ statusCode: 429, error: "rate_limit_exceeded", message: `Rate limit exceeded, retry in ${context.after}`, retryAfterMs: context.ttl })
});

const memoryAgents = [
  {
    id: "agentbase-verifier",
    name: "AgentBase Verifier",
    developer: "AgentBase",
    website: "https://agentbase.com.tr",
    description: "Kaynak ve güncellik doğrulama agent'ı",
    verified: true,
    reputation: 98
  }
];

const memoryEvents: Array<Record<string, unknown>> = [
  {
    id: "event_demo_1",
    eventType: "entity_retrieved",
    entityId: "city_ankara",
    agentId: "agentbase-verifier",
    agentName: "AgentBase Verifier",
    verified: true,
    payload: { message: "Ankara verisi kontrol edildi" },
    createdAt: new Date().toISOString()
  }
];

function slugify(value: string) {
  return value
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function requireAgent(request: FastifyRequest) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return authenticateAgentTokenDb(hashToken(auth.slice(7).trim()));
}

function searchMemory(query: string, type?: string, limit = 10) {
  const needle = query.toLocaleLowerCase("tr-TR");
  const words = needle.split(/\s+/).filter(Boolean);
  return entities
    .filter((entity) => !type || entity.type === type)
    .map((entity) => {
      const text = [
        entity.name,
        entity.summary,
        entity.location?.city,
        ...entity.facts.flatMap((fact) => Array.isArray(fact.value) ? fact.value : [String(fact.value)])
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("tr-TR");
      const score = text.includes(needle)
        ? 1
        : words.filter((word) => text.includes(word)).length / Math.max(1, words.length);
      return { entity, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function searchKnowledge(query: string, type?: string, limit = 10) {
  const dbRows = await searchEntitiesDb(query, type, limit);
  if (dbRows.length) {
    return dbRows.map((row) => ({
      id: row.id,
      slug: row.slug,
      type: row.type,
      name: row.name,
      summary: row.summary,
      location: row.location,
      score: row.score,
      confidence: row.confidence,
      updatedAt: row.updatedAt
    }));
  }
  return searchMemory(query, type, limit).map(({ entity, score }) => ({
    id: entity.id,
    slug: entity.slug,
    type: entity.type,
    name: entity.name,
    summary: entity.summary,
    location: entity.location,
    score,
    confidence: entity.facts.length
      ? entity.facts.reduce((sum, fact) => sum + fact.confidence, 0) / entity.facts.length
      : null,
    updatedAt: entity.updatedAt
  }));
}

async function resolveEntity(id: string) {
  const dbEntity = await getEntityDb(id);
  if (dbEntity) return dbEntity;
  return entities.find((item) => item.id === id || item.slug === id) ?? null;
}

app.get("/", async () => ({
  name: "AgentBase API",
  version: "0.4.0",
  description: "Türkiye'nin AI agent bilgi ağı",
  machineReadable: true,
  endpoints: [
    "/v1/search",
    "/v1/retrieve",
    "/v1/entities/:id",
    "/v1/entities/:id/facts",
    "/v1/entities/:id/sources",
    "/v1/entities/:id/relations",
    "/v1/entities/:id/agent-score",
    "/v1/entities/:id.jsonld",
    "/v1/agents",
    "/v1/agents/register",
    "/v1/activity",
    "/v1/ratings",
    "/v1/contributions",
    "/v1/changes",
    "/v1/stats",
    "/v1/ingest/url",
    "/v1/ingest/jobs/:id",
    "/mcp"
  ]
}));

app.get("/health", async () => ({
  ok: true,
  time: new Date().toISOString(),
  database: await dbHealth()
}));

app.get("/ready", async (_request, reply) => {
  const database = await dbHealth();
  if (database.mode !== 'postgres' || !database.ok) {
    return reply.status(503).send({ ok: false, ready: false, database });
  }
  return { ok: true, ready: true, database };
});

app.get("/v1/stats", async () => {
  const db = await getDbStats();
  if (db) return { ...db, mode: "postgres" };
  return {
    entities: entities.length,
    facts: entities.reduce((sum, entity) => sum + entity.facts.length, 0),
    sources: sources.length,
    agents: memoryAgents.length,
    eventsToday: memoryEvents.length,
    mode: "memory"
  };
});

const searchSchema = z.object({
  q: z.string().min(1),
  type: z.enum(["city", "place", "food", "business", "event", "book"]).optional(),
  limit: z.coerce.number().min(1).max(50).default(10)
});

app.get("/v1/search", async (request, reply) => {
  const parsed = searchSchema.safeParse(request.query);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_query", details: parsed.error.flatten() });
  const results = await searchKnowledge(parsed.data.q, parsed.data.type, parsed.data.limit);
  return {
    query: parsed.data.q,
    generatedAt: new Date().toISOString(),
    count: results.length,
    results
  };
});

const retrieveSchema = z.object({
  query: z.string().min(2).max(500),
  limit: z.coerce.number().min(1).max(25).default(10)
});

app.post("/v1/retrieve", async (request, reply) => {
  const parsed = retrieveSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_retrieval_query", details: parsed.error.flatten() });
  const cities = await listKnownCitiesDb();
  const intent = parseQuery(parsed.data.query, cities);
  const results = await semanticHybridRetrieveDb(intent, parsed.data.limit);
  return {
    query: parsed.data.query,
    generatedAt: new Date().toISOString(),
    retrievalMode: "semantic-hybrid-v2",
    intent,
    count: results.length,
    results
  };
});

app.post("/v1/embeddings/refresh", async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: "invalid_agent_token" });
  if (!agent.verified) return reply.status(403).send({ error: "verified_agent_required" });
  const results = await refreshAllEntityEmbeddingsDb();
  return { count: results.length, results };
});

app.post("/v1/entities/:id/embedding/refresh", async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: "invalid_agent_token" });
  if (!agent.verified) return reply.status(403).send({ error: "verified_agent_required" });
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  return await refreshEntityEmbeddingDb(entity.id);
});

app.get("/v1/entities/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  return entity;
});

app.get("/v1/entities/:id/facts", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  if ("createdAt" in entity) return { entityId: entity.id, facts: await getFactsDb(entity.id) };
  return { entityId: entity.id, facts: entity.facts };
});

app.get("/v1/entities/:id/facts-at", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = z.object({ at: z.string().datetime({ offset: true }) }).safeParse(request.query);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_timestamp", details: parsed.error.flatten() });
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  return { entityId: entity.id, at: parsed.data.at, facts: await getEntityFactsAtDb(entity.id, parsed.data.at) };
});

app.get("/v1/facts/:id/history", async (request) => {
  const { id } = request.params as { id: string };
  const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(request.query);
  const limit = parsed.success ? parsed.data.limit : 50;
  return { factId: id, history: await getFactHistoryDb(id, limit) };
});

app.get("/v1/entities/:id/sources", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  if ("createdAt" in entity) return { entityId: entity.id, sources: await getSourcesDb(entity.id) };
  return { entityId: entity.id, sources: sources.filter((source) => entity.sourceIds.includes(source.id)) };
});

app.get("/v1/entities/:id/relations", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  return { entityId: entity.id, relations: await getRelationsDb(entity.id) };
});

app.get("/v1/entities/:id/confidence", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  const result = await recomputeEntityConfidenceDb(entity.id);
  return result ?? { entityId: entity.id, score: null, facts: 0, conflicts: 0, breakdown: [] };
});

app.get("/v1/facts/:id/confidence-history", async (request) => {
  const { id } = request.params as { id: string };
  const q = request.query as { limit?: string };
  const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
  return { factId: id, history: await getFactConfidenceHistoryDb(id, limit) };
});

app.post("/v1/facts/:id/recompute-confidence", async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: "invalid_agent_token" });
  if (!agent.verified) return reply.status(403).send({ error: "verified_agent_required" });
  const { id } = request.params as { id: string };
  const result = await recomputeFactConfidenceDb(id, `agent:${agent.id}`);
  if (!result) return reply.status(404).send({ error: "fact_not_found" });
  return result;
});

app.get("/v1/entities/:id/agent-score", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  return { entityId: entity.id, ...(await getEntityAgentScoreDb(entity.id) ?? { ratings: 0, score: null }) };
});

app.get("/v1/entities/:id.jsonld", async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: "entity_not_found" });
  const facts = "facts" in entity ? entity.facts : await getFactsDb(entity.id);
  reply.type("application/ld+json");
  return {
    "@context": {
      "@vocab": "https://schema.org/",
      ab: "https://agentbase.com.tr/ns#"
    },
    "@id": `https://agentbase.com.tr/entity/${entity.id}`,
    "@type": entity.type === "city" ? "City" : entity.type === "business" ? "LocalBusiness" : entity.type === "place" ? "Place" : "Thing",
    name: entity.name,
    description: entity.summary,
    "ab:updatedAt": entity.updatedAt,
    "ab:facts": facts
  };
});

app.get("/v1/agents", async () => {
  const dbAgents = await listAgentsDb();
  const agents = dbAgents.length ? dbAgents : memoryAgents;
  return { count: agents.length, agents };
});

app.get("/v1/agents/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const agent = await getAgentDb(id) ?? memoryAgents.find((item) => item.id === id);
  if (!agent) return reply.status(404).send({ error: "agent_not_found" });
  return agent;
});

app.get("/v1/agents/:id/agent-card.json", async (request, reply) => {
  const { id } = request.params as { id: string };
  const agent = await getAgentDb(id) ?? memoryAgents.find((item) => item.id === id);
  if (!agent) return reply.status(404).send({ error: "agent_not_found" });
  return {
    name: agent.name,
    description: agent.description,
    url: `https://agentbase.com.tr/agents/${agent.id}`,
    version: "0.1.0",
    capabilities: { streaming: false },
    skills: [{ id: "agentbase-access", name: "AgentBase access", description: agent.description ?? "AgentBase agent" }]
  };
});

const registerAgentSchema = z.object({
  name: z.string().min(2).max(80),
  developer: z.string().min(2).max(120).optional(),
  website: z.string().url().optional(),
  description: z.string().max(500).optional()
});

app.post("/v1/agents/register", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
  const parsed = registerAgentSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_agent", details: parsed.error.flatten() });
  const health = await dbHealth();
  if (health.mode !== "postgres" || !health.ok) return reply.status(503).send({ error: "database_required" });

  const base = slugify(parsed.data.name) || "agent";
  const id = `${base}-${randomBytes(3).toString("hex")}`;
  const token = `ab_live_${randomBytes(24).toString("base64url")}`;
  const agent = await createAgentDb({ id, ...parsed.data });
  await createAgentTokenDb(id, hashToken(token));
  await createAgentEventDb({ agentId: id, eventType: "agent_registered", payload: { message: `${parsed.data.name} AgentBase'e katıldı` } });

  return reply.status(201).send({
    agent,
    token,
    tokenWarning: "Bu token yalnızca bir kez gösterilir. Güvenli bir yerde saklayın."
  });
});

const managedTokenSchema = z.object({
  label: z.string().min(1).max(80).default('api-key'),
  expiresAt: z.string().datetime().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10000).default(120),
  dailyQuota: z.number().int().min(1).max(10000000).default(10000)
});

app.get('/v1/agents/me/tokens', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  return { tokens: await listAgentTokensDb(agent.id), dailyUsage: agent.dailyUsage, dailyQuota: agent.dailyQuota };
});

app.post('/v1/agents/me/tokens', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  const parsed = managedTokenSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_token_settings', details: parsed.error.flatten() });
  const token = `ab_live_${randomBytes(24).toString('base64url')}`;
  const tokenRecord = await createManagedAgentTokenDb({ agentId: agent.id, tokenHash: hashToken(token), ...parsed.data });
  if (!tokenRecord) return reply.status(503).send({ error: 'database_required' });
  return reply.status(201).send({ token, tokenRecord, tokenWarning: 'Bu token yalnızca bir kez gösterilir.' });
});

app.delete('/v1/agents/me/tokens/:tokenId', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  const { tokenId } = request.params as { tokenId: string };
  if (tokenId === agent.tokenId) return reply.status(400).send({ error: 'cannot_revoke_current_token' });
  const revoked = await revokeAgentTokenDb(agent.id, tokenId);
  if (!revoked) return reply.status(404).send({ error: 'token_not_found' });
  return { revoked };
});

app.post('/v1/agents/me/tokens/rotate', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  const parsed = managedTokenSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_token_settings', details: parsed.error.flatten() });
  const token = `ab_live_${randomBytes(24).toString('base64url')}`;
  const tokenRecord = await rotateAgentTokenDb({
    agentId: agent.id,
    currentTokenId: agent.tokenId,
    tokenHash: hashToken(token),
    ...parsed.data
  });
  if (!tokenRecord) return reply.status(409).send({ error: 'token_rotation_failed' });
  return reply.status(201).send({ token, tokenRecord, tokenWarning: 'Eski token iptal edildi. Yeni token yalnızca bir kez gösterilir.' });
});

app.get("/v1/activity", async (request) => {
  const query = request.query as { limit?: string };
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const dbEvents = await recentPublicEvents(limit);
  return { events: dbEvents.length ? dbEvents : memoryEvents.slice(0, limit) };
});

const eventSchema = z.object({
  eventType: z.string().min(2).max(80),
  entityId: z.string().max(100).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  public: z.boolean().default(true)
});

app.post("/v1/activity", async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: "invalid_agent_token" });
  const parsed = eventSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_event", details: parsed.error.flatten() });
  const event = await createAgentEventDb({ agentId: agent.id, ...parsed.data });
  return reply.status(201).send({ event });
});

const ratingSchema = z.object({
  entityId: z.string().min(1),
  accuracy: z.number().min(0).max(1).optional(),
  freshness: z.number().min(0).max(1).optional(),
  completeness: z.number().min(0).max(1).optional(),
  machineReadability: z.number().min(0).max(1).optional(),
  comment: z.string().max(1000).optional()
}).refine((value) => [value.accuracy, value.freshness, value.completeness, value.machineReadability].some((v) => v !== undefined), {
  message: "En az bir puan alanı gerekli"
});

app.post("/v1/ratings", async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: "invalid_agent_token" });
  const parsed = ratingSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_rating", details: parsed.error.flatten() });
  if (!await resolveEntity(parsed.data.entityId)) return reply.status(404).send({ error: "entity_not_found" });
  const review = await createAgentReviewDb({ agentId: agent.id, ...parsed.data });
  await createAgentEventDb({ agentId: agent.id, entityId: parsed.data.entityId, eventType: "entity_rated", payload: { message: `${agent.name} bir kaynağı değerlendirdi` } });
  return reply.status(201).send({ review, agentScore: await getEntityAgentScoreDb(parsed.data.entityId) });
});

const contributionSchema = z.object({
  entityId: z.string().max(100).optional(),
  contributionType: z.enum(["fact_add", "fact_update", "source_add", "error_report", "relation_add"]),
  payload: z.record(z.string(), z.unknown()),
  evidence: z.array(z.unknown()).default([])
});

app.post("/v1/contributions", async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: "invalid_agent_token" });
  const parsed = contributionSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_contribution", details: parsed.error.flatten() });
  const contribution = await createContributionDb({ agentId: agent.id, ...parsed.data });
  await createAgentEventDb({
    agentId: agent.id,
    entityId: parsed.data.entityId,
    eventType: "contribution_submitted",
    payload: { message: `${agent.name} bilgi katkısı gönderdi`, contributionType: parsed.data.contributionType }
  });
  return reply.status(202).send({ contribution });
});

app.get("/v1/changes", async (request, reply) => {
  const schema = z.object({
    since: z.string().datetime(),
    limit: z.coerce.number().min(1).max(500).default(100)
  });
  const parsed = schema.safeParse(request.query);
  if (!parsed.success) return reply.status(400).send({ error: "invalid_query", details: parsed.error.flatten() });
  return { since: parsed.data.since, changes: await getChangesDb(parsed.data.since, parsed.data.limit) };
});


const ingestUrlSchema = z.object({
  url: z.string().url()
});

async function runIngestion(jobId: string, url: string) {
  try {
    await setIngestionJobRunningDb(jobId);
    const crawled = await crawlUrl(url);
    const document = await upsertSourceDocumentDb(crawled);
    if (!document) throw new Error('database_required');
    const claims = await extractClaimsAsync(crawled);
    await replaceExtractedClaimsDb(document.id, claims);
    await finishIngestionJobDb(jobId, 'completed', {
      documentId: document.id,
      canonicalUrl: document.canonicalUrl,
      httpStatus: document.httpStatus,
      title: document.title,
      claims: claims.length,
      bodyHash: document.bodyHash
    });
  } catch (error) {
    await finishIngestionJobDb(jobId, 'failed', {}, error instanceof Error ? error.message : String(error));
  }
}

app.post('/v1/ingest/url', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  const parsed = ingestUrlSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_url', details: parsed.error.flatten() });
  const health = await dbHealth();
  if (health.mode !== 'postgres' || !health.ok) return reply.status(503).send({ error: 'database_required' });

  const job = await createIngestionJobDb(parsed.data.url, agent.id);
  if (!job) return reply.status(503).send({ error: 'database_required' });
  const backgroundJob = await enqueueBackgroundJobDb('ingest_url', { ingestionJobId: job.id, url: parsed.data.url, requestedByAgentId: agent.id }, { priority: 60, maxAttempts: 3 });
  if (!backgroundJob) {
    await finishIngestionJobDb(job.id, 'failed', {}, 'background_queue_unavailable');
    return reply.status(503).send({ error: 'background_queue_unavailable' });
  }
  return reply.status(202).send({ job, backgroundJob });
});

app.get('/v1/ingest/jobs/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const job = await getIngestionJobDb(id);
  if (!job) return reply.status(404).send({ error: 'ingestion_job_not_found' });
  return job;
});

app.get('/v1/ingest/documents/:id/claims', async (request, reply) => {
  const { id } = request.params as { id: string };
  return { documentId: id, claims: await listExtractedClaimsDb(id) };
});


app.get('/v1/entities/resolve', async (request, reply) => {
  const schema = z.object({ q: z.string().min(1), limit: z.coerce.number().min(1).max(10).default(5) });
  const parsed = schema.safeParse(request.query);
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_query', details: parsed.error.flatten() });
  const candidates = await resolveEntityCandidatesDb(parsed.data.q, parsed.data.limit);
  return { query: parsed.data.q, candidates };
});

app.get('/v1/entities/:id/aliases', async (request, reply) => {
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: 'entity_not_found' });
  return { entityId: entity.id, aliases: await listEntityAliasesDb(entity.id) };
});

const aliasSchema = z.object({ alias: z.string().min(2).max(160), confidence: z.number().min(0).max(1).default(1) });
app.post('/v1/entities/:id/aliases', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  if (!agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const parsed = aliasSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_alias', details: parsed.error.flatten() });
  const { id } = request.params as { id: string };
  const entity = await resolveEntity(id);
  if (!entity) return reply.status(404).send({ error: 'entity_not_found' });
  const alias = await addEntityAliasDb({ entityId: entity.id, alias: parsed.data.alias, source: `agent:${agent.id}`, confidence: parsed.data.confidence });
  return reply.status(201).send({ alias });
});

app.post('/v1/ingest/claims/:id/resolve-entity', async (request, reply) => {
  const { id } = request.params as { id: string };
  const resolution = await resolveClaimEntityDb(id);
  if (!resolution) return reply.status(404).send({ error: 'claim_not_found' });
  return resolution;
});

app.get('/v1/ingest/claims', async (request) => {
  const q = request.query as { limit?: string };
  const limit = Math.min(500, Math.max(1, Number(q.limit || 100)));
  return { claims: await listPendingClaimsDb(limit) };
});

const claimReviewSchema = z.object({
  status: z.enum(['accepted','rejected','conflicting']),
  note: z.string().max(1000).optional(),
  targetEntityId: z.string().max(100).optional()
});

app.post('/v1/ingest/claims/:id/review', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  if (!agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const parsed = claimReviewSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_review', details: parsed.error.flatten() });
  const { id } = request.params as { id: string };
  if (parsed.data.targetEntityId && !await resolveEntity(parsed.data.targetEntityId)) return reply.status(404).send({ error: 'target_entity_not_found' });
  if (parsed.data.status === 'accepted' && !parsed.data.targetEntityId) {
    return reply.status(400).send({ error: 'target_entity_required_for_accepted_claim' });
  }
  const claim = await reviewExtractedClaimDb({ id, agentId: agent.id, ...parsed.data });
  if (!claim) return reply.status(404).send({ error: 'claim_not_found_or_already_reviewed' });
  const promotion = parsed.data.status === 'accepted' ? await promoteAcceptedClaimToFactDb(id) : null;
  const confidence = promotion ? await recomputeFactConfidenceDb(promotion.factId, 'claim_promotion') : null;
  await createAgentEventDb({
    agentId: agent.id,
    entityId: parsed.data.targetEntityId,
    eventType: promotion?.outcome === 'conflict' ? 'fact_conflict_detected' : promotion ? 'fact_promoted' : 'claim_reviewed',
    payload: {
      message: promotion
        ? `${agent.name} onaylanan iddiayı knowledge graph fact kaydına dönüştürdü`
        : `${agent.name} bir veri iddiasını ${parsed.data.status} olarak işaretledi`,
      claimId: id,
      factId: promotion?.factId,
      outcome: promotion?.outcome,
      confidence: confidence?.score
    }
  });
  return { claim, promotion, confidence };
});


const sourceRegistrySchema = z.object({
  name: z.string().min(2).max(160),
  baseUrl: z.string().url(),
  sourceType: z.enum(['official','public','editorial','business']).default('public'),
  authorityScore: z.number().min(0).max(1).default(0.5),
  maxPagesPerRun: z.number().int().min(1).max(100).default(10),
  crawlDelayMs: z.number().int().min(0).max(10000).default(1200),
  respectRobots: z.boolean().default(true)
});

app.get('/v1/sources/registry', async () => ({ sources: await listSourceRegistryDb() }));

app.post('/v1/sources/registry', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  if (!agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const parsed = sourceRegistrySchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_source', details: parsed.error.flatten() });
  const base = new URL(parsed.data.baseUrl);
  base.hash = '';
  const source = await createSourceRegistryDb({ ...parsed.data, baseUrl: base.toString() });
  if (!source) return reply.status(503).send({ error: 'database_required' });
  await enqueueSourceUrlDb(source.id, source.baseUrl, 0);
  return reply.status(201).send({ source });
});

async function runSourceRegistry(sourceId: string) {
  const source = await getSourceRegistryDb(sourceId);
  if (!source || !source.crawlEnabled) return { sourceId, processed: 0, completed: 0, failed: 0, blocked: 0, discovered: 0 };
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
  return { ...stats, autoEntities, autoReview };
}

const autoReviewSchema = z.object({
  sourceRegistryId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(1000).default(200)
});

const autoEntitySchema = z.object({
  sourceRegistryId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).default(100)
});

app.post('/v1/ingest/auto-create-entities', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  if (!agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const parsed = autoEntitySchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_auto_entity_request', details: parsed.error.flatten() });
  const result = await autoCreateEntitiesDb(parsed.data.sourceRegistryId, parsed.data.limit);
  return result ?? reply.status(503).send({ error: 'database_required' });
});

app.get('/v1/entities/creation-audit', async (request) => {
  const q = request.query as { limit?: string };
  const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
  return { audit: await listEntityCreationAuditDb(limit) };
});

app.post('/v1/ingest/auto-review', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  if (!agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const parsed = autoReviewSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.status(400).send({ error: 'invalid_auto_review_request', details: parsed.error.flatten() });
  const result = await autoReviewPendingClaimsDb(parsed.data.sourceRegistryId, parsed.data.limit);
  if (!result) return reply.status(503).send({ error: 'database_required' });
  await createAgentEventDb({
    agentId: agent.id,
    eventType: 'auto_review_completed',
    payload: {
      message: 'Otomatik claim inceleme turu tamamlandı',
      sourceRegistryId: parsed.data.sourceRegistryId ?? null,
      examined: result.examined,
      accepted: result.accepted,
      deferred: result.deferred,
      conflicted: result.conflicted,
      promoted: result.promoted,
      policyVersion: result.policyVersion
    }
  });
  return result;
});

app.get('/v1/ingest/auto-review/runs', async (request) => {
  const q = request.query as { limit?: string };
  const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
  return { runs: await listAutoReviewRunsDb(limit) };
});

app.post('/v1/sources/registry/:id/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent) return reply.status(401).send({ error: 'invalid_agent_token' });
  if (!agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const { id } = request.params as { id: string };
  const source = await getSourceRegistryDb(id);
  if (!source) return reply.status(404).send({ error: 'source_registry_not_found' });
  const job = await enqueueBackgroundJobDb('source_crawl', { sourceId: id, requestedByAgentId: agent.id }, { priority: 50, maxAttempts: 3 });
  if (!job) return reply.status(503).send({ error: 'database_required' });
  await createAgentEventDb({ agentId: agent.id, eventType: 'source_crawl_queued', payload: { message: source.name + ' kaynağı tarama kuyruğuna eklendi', sourceId: id, jobId: job.id } });
  return reply.status(202).send({ source, job });
});

app.get('/v1/jobs/:id', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent || !agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const { id } = request.params as { id: string };
  const job = await getBackgroundJobDb(id);
  if (!job) return reply.status(404).send({ error: 'job_not_found' });
  return { job };
});

app.get('/v1/jobs', async (request, reply) => {
  const agent = await requireAgent(request);
  if (!agent || !agent.verified) return reply.status(403).send({ error: 'verified_agent_required' });
  const q = request.query as { limit?: string; status?: string };
  const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
  return { jobs: await listBackgroundJobsDb(limit, q.status) };
});

app.get("/.well-known/agent-card.json", async () => ({
  name: "AgentBase",
  description: "Türkiye AI agent bilgi ve keşif ağı",
  url: "https://agentbase.com.tr",
  version: "0.4.0",
  capabilities: { streaming: false },
  skills: [
    { id: "search", name: "Search Turkish knowledge", description: "Türkiye odaklı entity ve fact araması" },
    { id: "get-entity", name: "Get entity", description: "Kimliği bilinen entity bilgisini getirir" }
  ]
}));

app.all("/mcp", async (request, reply) => {
  reply.hijack();
  await mcpNodeHandler(request.raw, reply.raw, request.body);
});

const port = Number(process.env.PORT || 4000);
await app.listen({ port, host: "0.0.0.0" });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'graceful shutdown started');
  const timeout = setTimeout(() => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  }, Math.max(1000, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000)));
  timeout.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error, 'graceful shutdown failed');
    process.exit(1);
  }
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

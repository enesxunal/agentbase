import crypto from "node:crypto";
import pg from "pg";
import { calculateConfidence } from "./confidence.js";
import { contentHash, cosineSimilarity, embedText, embeddingModel } from "./embeddings.js";
import { facetTerms, normalizeQuery, type QueryIntent } from "./retrieval.js";

const { Pool } = pg;

const databaseSsl = process.env.DATABASE_SSL === 'true'
  ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
  : undefined;

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Math.max(1, Number(process.env.DATABASE_POOL_MAX || 10)),
      idleTimeoutMillis: Math.max(1000, Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000)),
      connectionTimeoutMillis: Math.max(1000, Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 10000)),
      ssl: databaseSsl
    })
  : null;

export type DbAgent = {
  id: string;
  name: string;
  developer: string | null;
  website: string | null;
  description: string | null;
  verified: boolean;
  reputation: number;
  createdAt: string;
  updatedAt: string;
  organization?: string | null;
  domain?: string | null;
  agentCardUrl?: string | null;
  capabilities?: unknown[];
  protocols?: string[];
  identityTier?: string;
  verificationMethod?: string | null;
  verifiedAt?: string | null;
  lastSeenAt?: string | null;
  metadata?: Record<string, unknown>;
};

export async function dbHealth() {
  if (!pool) return { configured: false, ok: true, mode: "memory" as const };
  try {
    await pool.query("select 1");
    return { configured: true, ok: true, mode: "postgres" as const };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      mode: "postgres" as const,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function getDbStats() {
  if (!pool) return null;
  const result = await pool.query(`
    select
      (select count(*)::int from entities) as entities,
      (select count(*)::int from facts) as facts,
      (select count(*)::int from sources) as sources,
      (select count(*)::int from agents) as agents,
      (select count(*)::int from agent_events where created_at >= date_trunc('day', now())) as "eventsToday"
  `);
  return result.rows[0];
}

export async function searchEntitiesDb(query: string, type: string | undefined, limit: number) {
  if (!pool) return [];
  const words = query.toLocaleLowerCase("tr-TR").split(/\s+/).filter(Boolean);
  const params: unknown[] = [];
  let where = "true";
  if (type) {
    params.push(type);
    where += ` and e.type = $${params.length}`;
  }
  params.push(Math.max(limit * 8, 50));
  const result = await pool.query(
    `select e.id, e.slug, e.type, e.name, e.summary, e.location,
            e.updated_at as "updatedAt",
            coalesce(avg(f.confidence), 0)::float as confidence,
            coalesce(string_agg(f.value::text, ' '), '') as "factText"
       from entities e
       left join facts f on f.subject_entity_id = e.id and f.is_current=true
      where ${where}
      group by e.id
      order by e.updated_at desc
      limit $${params.length}`,
    params
  );

  return result.rows
    .map((row) => {
      const text = [row.name, row.summary, JSON.stringify(row.location ?? {}), row.factText]
        .join(" ")
        .toLocaleLowerCase("tr-TR");
      const needle = query.toLocaleLowerCase("tr-TR");
      const score = text.includes(needle)
        ? 1
        : words.filter((word) => text.includes(word)).length / Math.max(1, words.length);
      return { ...row, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function getEntityDb(idOrSlug: string) {
  if (!pool) return null;
  const entityResult = await pool.query(
    `select id, slug, type, name, summary, location,
            created_at as "createdAt", updated_at as "updatedAt"
       from entities where id = $1 or slug = $1 limit 1`,
    [idOrSlug]
  );
  if (!entityResult.rowCount) return null;
  const entity = entityResult.rows[0];
  const [facts, sources, relations, agentScore] = await Promise.all([
    getFactsDb(entity.id),
    getSourcesDb(entity.id),
    getRelationsDb(entity.id),
    getEntityAgentScoreDb(entity.id)
  ]);
  return { ...entity, facts, sources, relations, agentScore };
}

export async function getFactsDb(entityId: string) {
  if (!pool) return [];
  const result = await pool.query(
    `select f.id, f.predicate, f.value, f.confidence::float, f.status,
            f.version_group_id as "versionGroupId", f.version_no as "versionNo", f.is_current as "isCurrent",
            f.valid_from as "validFrom", f.valid_to as "validTo",
            f.last_checked as "lastChecked",
            coalesce(json_agg(json_build_object(
              'id', s.id,
              'name', s.name,
              'url', s.url,
              'type', s.type,
              'authorityScore', s.authority_score::float,
              'evidence', fs.evidence
            )) filter (where s.id is not null), '[]'::json) as sources
       from facts f
       left join fact_sources fs on fs.fact_id = f.id
       left join sources s on s.id = fs.source_id
      where f.subject_entity_id = $1 and f.is_current = true
      group by f.id
      order by f.predicate, f.id`,
    [entityId]
  );
  return result.rows;
}

export async function getSourcesDb(entityId: string) {
  if (!pool) return [];
  const result = await pool.query(
    `select distinct s.id, s.name, s.url, s.type,
            s.authority_score::float as "authorityScore",
            s.retrieved_at as "retrievedAt"
       from sources s
       join fact_sources fs on fs.source_id = s.id
       join facts f on f.id = fs.fact_id
      where f.subject_entity_id = $1
      order by s.name`,
    [entityId]
  );
  return result.rows;
}

export async function getRelationsDb(entityId: string) {
  if (!pool) return [];
  const result = await pool.query(
    `select r.id, r.predicate, r.confidence::float,
            target.id as "targetId", target.slug as "targetSlug",
            target.type as "targetType", target.name as "targetName"
       from relations r
       join entities target on target.id = r.object_entity_id
      where r.subject_entity_id = $1
      order by r.predicate, target.name`,
    [entityId]
  );
  return result.rows;
}

export async function listAgentsDb(limit = 100) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, name, developer, website, description, verified, organization, domain,
            agent_card_url as "agentCardUrl", capabilities, protocols, identity_tier as "identityTier",
            verification_method as "verificationMethod", verified_at as "verifiedAt", last_seen_at as "lastSeenAt", metadata,
            reputation::float, created_at as "createdAt", updated_at as "updatedAt"
       from agents order by verified desc, reputation desc, created_at desc limit $1`,
    [limit]
  );
  return result.rows as DbAgent[];
}

export async function getAgentDb(id: string) {
  if (!pool) return null;
  const result = await pool.query(
    `select id, name, developer, website, description, verified, organization, domain,
            agent_card_url as "agentCardUrl", capabilities, protocols, identity_tier as "identityTier",
            verification_method as "verificationMethod", verified_at as "verifiedAt", last_seen_at as "lastSeenAt", metadata,
            reputation::float, created_at as "createdAt", updated_at as "updatedAt"
       from agents where id = $1 limit 1`,
    [id]
  );
  return (result.rows[0] as DbAgent | undefined) ?? null;
}

export async function createAgentDb(input: {
  id: string;
  name: string;
  developer?: string;
  website?: string;
  description?: string;
  organization?: string;
  domain?: string;
  agentCardUrl?: string;
  capabilities?: unknown[];
  protocols?: string[];
}) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into agents (id, name, developer, website, description, organization, domain, agent_card_url, capabilities, protocols)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
     returning id, name, developer, website, description, verified, organization, domain,
               agent_card_url as "agentCardUrl", capabilities, protocols, identity_tier as "identityTier",
               reputation::float, created_at as "createdAt", updated_at as "updatedAt"`,
    [input.id, input.name, input.developer ?? null, input.website ?? null, input.description ?? null,
     input.organization ?? null, input.domain ?? null, input.agentCardUrl ?? null, JSON.stringify(input.capabilities ?? []), JSON.stringify(input.protocols ?? ['mcp'])]
  );
  return result.rows[0] as DbAgent;
}


export async function touchAgentSeenDb(agentId: string) {
  if (!pool) return null;
  const result = await pool.query(`update agents set last_seen_at=now(), updated_at=now() where id=$1 returning last_seen_at as "lastSeenAt"`, [agentId]);
  return result.rows[0] ?? null;
}

export async function getAgentRegistryStatsDb() {
  if (!pool) return null;
  const result = await pool.query(`select count(*)::int as total, count(*) filter (where verified)::int as verified,
    count(*) filter (where identity_tier in ('domain_verified','organization_verified','trusted'))::int as "identityVerified",
    count(*) filter (where last_seen_at >= now() - interval '24 hours')::int as "active24h" from agents`);
  return result.rows[0] ?? null;
}

export async function updateAgentProfileDb(agentId: string, input: { organization?: string|null; domain?: string|null; agentCardUrl?: string|null; capabilities?: unknown[]; protocols?: string[]; metadata?: Record<string,unknown> }) {
  if (!pool) return null;
  const result = await pool.query(`update agents set
    organization=coalesce($2,organization), domain=coalesce($3,domain), agent_card_url=coalesce($4,agent_card_url),
    capabilities=coalesce($5::jsonb,capabilities), protocols=coalesce($6::jsonb,protocols), metadata=coalesce($7::jsonb,metadata), updated_at=now()
    where id=$1 returning id,name,developer,website,description,verified,organization,domain,agent_card_url as "agentCardUrl",capabilities,protocols,
      identity_tier as "identityTier",verification_method as "verificationMethod",verified_at as "verifiedAt",last_seen_at as "lastSeenAt",metadata,reputation::float`,
    [agentId,input.organization ?? null,input.domain ?? null,input.agentCardUrl ?? null,input.capabilities ? JSON.stringify(input.capabilities) : null,input.protocols ? JSON.stringify(input.protocols) : null,input.metadata ? JSON.stringify(input.metadata) : null]);
  return result.rows[0] ?? null;
}


export async function createAgentIdentityChallengeDb(agentId: string, domain: string, challengeToken: string, ttlMinutes = 30) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into agent_identity_challenges (agent_id,challenge_type,domain,challenge_token,expires_at)
     values ($1,'domain_http',$2,$3,now() + make_interval(mins => $4))
     returning id,agent_id as "agentId",challenge_type as "challengeType",domain,challenge_token as "challengeToken",
       status,expires_at as "expiresAt",created_at as "createdAt"`,
    [agentId, domain, challengeToken, ttlMinutes]
  );
  return result.rows[0] ?? null;
}

export async function getAgentIdentityChallengeDb(agentId: string, challengeId: string) {
  if (!pool) return null;
  const result = await pool.query(
    `select id,agent_id as "agentId",challenge_type as "challengeType",domain,challenge_token as "challengeToken",status,
      expires_at as "expiresAt",verified_at as "verifiedAt",created_at as "createdAt"
      from agent_identity_challenges where id=$1 and agent_id=$2`, [challengeId, agentId]
  );
  return result.rows[0] ?? null;
}

export async function verifyAgentIdentityChallengeDb(agentId: string, challengeId: string) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const challenge = await client.query(
      `update agent_identity_challenges set status='verified',verified_at=now()
       where id=$1 and agent_id=$2 and status='pending' and expires_at > now()
       returning id,domain,verified_at as "verifiedAt"`, [challengeId, agentId]
    );
    if (!challenge.rowCount) { await client.query('rollback'); return null; }
    const agent = await client.query(
      `update agents set domain=$2,verified=true,identity_tier=case when identity_tier='trusted' then 'trusted' else 'domain_verified' end,
        verification_method='domain_http',verified_at=coalesce(verified_at,now()),updated_at=now()
       where id=$1 returning id,name,developer,website,description,verified,organization,domain,agent_card_url as "agentCardUrl",capabilities,protocols,
        identity_tier as "identityTier",verification_method as "verificationMethod",verified_at as "verifiedAt",last_seen_at as "lastSeenAt",metadata,reputation::float`,
      [agentId, challenge.rows[0].domain]
    );
    await client.query('commit');
    return { challenge: challenge.rows[0], agent: agent.rows[0] };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function createAgentTokenDb(agentId: string, tokenHash: string, label = "default") {
  if (!pool) return null;
  await pool.query(
    `insert into agent_tokens (agent_id, token_hash, label) values ($1, $2, $3)`,
    [agentId, tokenHash, label]
  );
  return true;
}

export type AuthenticatedAgent = DbAgent & {
  tokenId: string;
  tokenLabel: string;
  rateLimitPerMinute: number;
  dailyQuota: number;
  dailyUsage: number;
};

export async function authenticateAgentTokenDb(tokenHash: string): Promise<AuthenticatedAgent | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update agent_tokens t
          set last_used_at = now()
         from agents a
        where t.token_hash = $1
          and t.revoked_at is null
          and (t.expires_at is null or t.expires_at > now())
          and a.id = t.agent_id
        returning a.id, a.name, a.developer, a.website, a.description,
                  a.verified, a.reputation::float,
                  a.created_at as "createdAt", a.updated_at as "updatedAt",
                  t.id as "tokenId", t.label as "tokenLabel",
                  t.rate_limit_per_minute as "rateLimitPerMinute",
                  t.daily_quota as "dailyQuota"`,
      [tokenHash]
    );
    const agent = result.rows[0];
    if (!agent) { await client.query('rollback'); return null; }
    const usage = await client.query(
      `insert into agent_api_usage (agent_id, usage_date, request_count)
       values ($1, current_date, 1)
       on conflict (agent_id, usage_date) do update
         set request_count = agent_api_usage.request_count + 1, updated_at=now()
       returning request_count::int as count`, [agent.id]
    );
    const dailyUsage = Number(usage.rows[0]?.count ?? 0);
    if (dailyUsage > Number(agent.dailyQuota)) {
      await client.query('rollback');
      return null;
    }
    await client.query('commit');
    return { ...agent, dailyUsage } as AuthenticatedAgent;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function listAgentTokensDb(agentId: string) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, label, created_at as "createdAt", last_used_at as "lastUsedAt",
            revoked_at as "revokedAt", expires_at as "expiresAt",
            rate_limit_per_minute as "rateLimitPerMinute", daily_quota as "dailyQuota"
       from agent_tokens where agent_id=$1 order by created_at desc`, [agentId]
  );
  return result.rows;
}

export async function revokeAgentTokenDb(agentId: string, tokenId: string) {
  if (!pool) return null;
  const result = await pool.query(
    `update agent_tokens set revoked_at=coalesce(revoked_at,now())
      where id=$1 and agent_id=$2
      returning id, label, revoked_at as "revokedAt"`, [tokenId, agentId]
  );
  return result.rows[0] ?? null;
}

export async function createManagedAgentTokenDb(input: { agentId: string; tokenHash: string; label: string; expiresAt?: string | null; rateLimitPerMinute?: number; dailyQuota?: number }) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into agent_tokens (agent_id, token_hash, label, expires_at, rate_limit_per_minute, daily_quota)
     values ($1,$2,$3,$4,$5,$6)
     returning id,label,created_at as "createdAt",expires_at as "expiresAt",
       rate_limit_per_minute as "rateLimitPerMinute",daily_quota as "dailyQuota"`,
    [input.agentId,input.tokenHash,input.label,input.expiresAt ?? null,input.rateLimitPerMinute ?? 120,input.dailyQuota ?? 10000]
  );
  return result.rows[0] ?? null;
}

export async function rotateAgentTokenDb(input: { agentId: string; currentTokenId: string; tokenHash: string; label: string; expiresAt?: string | null; rateLimitPerMinute?: number; dailyQuota?: number }) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query(
      `select id from agent_tokens where id=$1 and agent_id=$2 and revoked_at is null for update`,
      [input.currentTokenId, input.agentId]
    );
    if (!current.rowCount) { await client.query('rollback'); return null; }
    const created = await client.query(
      `insert into agent_tokens (agent_id, token_hash, label, expires_at, rate_limit_per_minute, daily_quota)
       values ($1,$2,$3,$4,$5,$6)
       returning id,label,created_at as "createdAt",expires_at as "expiresAt",
         rate_limit_per_minute as "rateLimitPerMinute",daily_quota as "dailyQuota"`,
      [input.agentId,input.tokenHash,input.label,input.expiresAt ?? null,input.rateLimitPerMinute ?? 120,input.dailyQuota ?? 10000]
    );
    await client.query(`update agent_tokens set revoked_at=now() where id=$1`, [input.currentTokenId]);
    await client.query('commit');
    return created.rows[0] ?? null;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function recentPublicEvents(limit = 20) {
  if (!pool) return [];
  const result = await pool.query(
    `select e.id, e.event_type as "eventType", e.entity_id as "entityId",
            e.payload, e.created_at as "createdAt",
            a.id as "agentId", a.name as "agentName", a.verified
       from agent_events e
       left join agents a on a.id = e.agent_id
      where e.public = true
      order by e.created_at desc
      limit $1`,
    [limit]
  );
  return result.rows;
}

export async function createAgentEventDb(input: {
  agentId: string;
  eventType: string;
  entityId?: string;
  payload?: Record<string, unknown>;
  public?: boolean;
}) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into agent_events (agent_id, event_type, entity_id, payload, public)
     values ($1, $2, $3, $4::jsonb, $5)
     returning id, agent_id as "agentId", event_type as "eventType",
               entity_id as "entityId", payload, public, created_at as "createdAt"`,
    [input.agentId, input.eventType, input.entityId ?? null, JSON.stringify(input.payload ?? {}), input.public ?? true]
  );
  return result.rows[0];
}

export async function createAgentReviewDb(input: {
  agentId: string;
  entityId: string;
  accuracy?: number;
  freshness?: number;
  completeness?: number;
  machineReadability?: number;
  comment?: string;
}) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into agent_reviews (
       agent_id, entity_id, accuracy, freshness, completeness, machine_readability, comment
     ) values ($1,$2,$3,$4,$5,$6,$7)
     returning id, agent_id as "agentId", entity_id as "entityId",
               accuracy::float, freshness::float, completeness::float,
               machine_readability::float as "machineReadability", comment,
               created_at as "createdAt"`,
    [
      input.agentId,
      input.entityId,
      input.accuracy ?? null,
      input.freshness ?? null,
      input.completeness ?? null,
      input.machineReadability ?? null,
      input.comment ?? null
    ]
  );
  return result.rows[0];
}

export async function getEntityAgentScoreDb(entityId: string) {
  if (!pool) return null;
  const result = await pool.query(
    `select count(*)::int as ratings,
            avg((coalesce(r.accuracy,0) + coalesce(r.freshness,0) +
                 coalesce(r.completeness,0) + coalesce(r.machine_readability,0)) /
                nullif((case when r.accuracy is null then 0 else 1 end +
                        case when r.freshness is null then 0 else 1 end +
                        case when r.completeness is null then 0 else 1 end +
                        case when r.machine_readability is null then 0 else 1 end), 0))::float as score
       from agent_reviews r
      where r.entity_id = $1`,
    [entityId]
  );
  const row = result.rows[0];
  if (!row || row.ratings === 0 || row.score == null) return { ratings: 0, score: null };
  return { ratings: row.ratings, score: Math.round(row.score * 100) / 100 };
}

export async function createContributionDb(input: {
  agentId: string;
  entityId?: string;
  contributionType: string;
  payload: Record<string, unknown>;
  evidence?: unknown[];
}) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into agent_contributions (
       agent_id, entity_id, contribution_type, payload, evidence
     ) values ($1,$2,$3,$4::jsonb,$5::jsonb)
     returning id, agent_id as "agentId", entity_id as "entityId",
               contribution_type as "contributionType", payload, evidence, status,
               created_at as "createdAt"`,
    [
      input.agentId,
      input.entityId ?? null,
      input.contributionType,
      JSON.stringify(input.payload),
      JSON.stringify(input.evidence ?? [])
    ]
  );
  return result.rows[0];
}

export async function getChangesDb(since: string, limit = 100) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, slug, type, name, updated_at as "updatedAt"
       from entities
      where updated_at > $1::timestamptz
      order by updated_at asc
      limit $2`,
    [since, limit]
  );
  return result.rows;
}

export async function createIngestionJobDb(url: string, requestedByAgentId?: string) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into ingestion_jobs (url, requested_by_agent_id) values ($1,$2)
     returning id, url, status, requested_by_agent_id as "requestedByAgentId", created_at as "createdAt"`,
    [url, requestedByAgentId ?? null]
  );
  return result.rows[0];
}

export async function setIngestionJobRunningDb(id: string) {
  if (!pool) return null;
  const result = await pool.query(
    `update ingestion_jobs set status='running', started_at=now(), error=null where id=$1
     returning id, url, status, started_at as "startedAt"`, [id]
  );
  return result.rows[0] ?? null;
}

export async function finishIngestionJobDb(id: string, status: 'completed'|'failed', resultData: Record<string, unknown> = {}, error?: string) {
  if (!pool) return null;
  const result = await pool.query(
    `update ingestion_jobs set status=$2, result=$3::jsonb, error=$4, finished_at=now() where id=$1
     returning id, url, status, result, error, created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"`,
    [id, status, JSON.stringify(resultData), error ?? null]
  );
  return result.rows[0] ?? null;
}

export async function getIngestionJobDb(id: string) {
  if (!pool) return null;
  const result = await pool.query(
    `select id, url, status, result, error, requested_by_agent_id as "requestedByAgentId",
            created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"
       from ingestion_jobs where id=$1`, [id]
  );
  return result.rows[0] ?? null;
}

export async function upsertSourceDocumentDb(input: {
  url: string; canonicalUrl: string | null; title: string | null; description: string | null;
  contentType: string | null; httpStatus: number; etag: string | null; lastModified: string | null;
  bodyHash: string; rawText: string; jsonld: unknown[]; metadata: Record<string, unknown>; sourceRegistryId?: string;
}) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into source_documents
      (url, canonical_url, title, description, content_type, http_status, etag, last_modified, body_hash, raw_text, jsonld, metadata, source_registry_id, fetched_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,now())
     on conflict (url) do update set
       canonical_url=excluded.canonical_url, title=excluded.title, description=excluded.description,
       content_type=excluded.content_type, http_status=excluded.http_status, etag=excluded.etag,
       last_modified=excluded.last_modified, body_hash=excluded.body_hash, raw_text=excluded.raw_text,
       jsonld=excluded.jsonld, metadata=excluded.metadata, source_registry_id=coalesce(excluded.source_registry_id,source_documents.source_registry_id), fetched_at=now(), updated_at=now()
     returning id, url, canonical_url as "canonicalUrl", title, description, content_type as "contentType",
               http_status as "httpStatus", body_hash as "bodyHash", fetched_at as "fetchedAt"`,
    [input.url,input.canonicalUrl,input.title,input.description,input.contentType,input.httpStatus,input.etag,input.lastModified,input.bodyHash,input.rawText,JSON.stringify(input.jsonld),JSON.stringify(input.metadata),input.sourceRegistryId??null]
  );
  return result.rows[0];
}

export async function replaceExtractedClaimsDb(documentId: string, claims: Array<{ subjectName: string | null; subjectType?: string | null; predicate: string; value: unknown; confidence: number; evidence?: string }>) {
  if (!pool) return [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from extracted_claims where document_id=$1 and status=$2', [documentId, 'pending']);
    const rows = [];
    for (const claim of claims) {
      const result = await client.query(
        `insert into extracted_claims (document_id, subject_name, subject_type, predicate, value, confidence, evidence)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7)
         returning id, subject_name as "subjectName", subject_type as "subjectType", predicate, value, confidence::float, status, evidence, created_at as "createdAt"`,
        [documentId, claim.subjectName, claim.subjectType ?? null, claim.predicate, JSON.stringify(claim.value), claim.confidence, claim.evidence ?? null]
      );
      rows.push(result.rows[0]);
    }
    await client.query('commit');
    return rows;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function listExtractedClaimsDb(documentId: string) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, subject_name as "subjectName", subject_type as "subjectType", predicate, value, confidence::float, status, evidence, created_at as "createdAt"
       from extracted_claims where document_id=$1 order by confidence desc, created_at asc`, [documentId]
  );
  return result.rows;
}

export async function listPendingClaimsDb(limit = 100) {
  if (!pool) return [];
  const result = await pool.query(
    `select c.id, c.document_id as "documentId", c.subject_name as "subjectName", c.predicate,
            c.value, c.confidence::float, c.status, c.evidence, c.created_at as "createdAt",
            d.url, d.title as "documentTitle", d.fetched_at as "fetchedAt"
       from extracted_claims c
       join source_documents d on d.id = c.document_id
      where c.status='pending'
      order by c.confidence desc, c.created_at asc
      limit $1`, [limit]
  );
  return result.rows;
}

export async function reviewExtractedClaimDb(input: { id: string; status: 'accepted'|'rejected'|'conflicting'; agentId: string; note?: string; targetEntityId?: string }) {
  if (!pool) return null;
  const result = await pool.query(
    `update extracted_claims
        set status=$2, reviewed_at=now(), reviewed_by_agent_id=$3, review_note=$4, target_entity_id=$5
      where id=$1 and status='pending'
      returning id, document_id as "documentId", subject_name as "subjectName", predicate, value,
                confidence::float, status, evidence, target_entity_id as "targetEntityId",
                reviewed_by_agent_id as "reviewedByAgentId", review_note as "reviewNote", reviewed_at as "reviewedAt"`,
    [input.id, input.status, input.agentId, input.note ?? null, input.targetEntityId ?? null]
  );
  return result.rows[0] ?? null;
}

export type PromoteClaimResult = {
  claimId: string;
  entityId: string;
  factId: string;
  outcome: 'created' | 'confirmed' | 'conflict' | 'superseded';
  confidence: number;
  conflictingFactIds: string[];
};

export async function promoteAcceptedClaimToFactDb(claimId: string): Promise<PromoteClaimResult | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claimResult = await client.query(
      `select c.id, c.document_id as "documentId", c.target_entity_id as "targetEntityId",
              c.predicate, c.value, c.confidence::float, c.status, c.evidence,
              c.promoted_fact_id as "promotedFactId",
              d.url, d.title, d.fetched_at as "fetchedAt",
              coalesce(sr.authority_score::float, 0.65) as "authorityScore",
              coalesce(sr.source_type, 'public') as "sourceType"
         from extracted_claims c
         join source_documents d on d.id = c.document_id
         left join source_registry sr on sr.id=d.source_registry_id
        where c.id=$1
        for update of c`,
      [claimId]
    );
    if (!claimResult.rowCount) { await client.query('rollback'); return null; }
    const claim = claimResult.rows[0];
    if (claim.status !== 'accepted' || !claim.targetEntityId) {
      throw new Error('accepted_claim_with_target_required');
    }
    if (claim.promotedFactId) {
      const existing = await client.query(`select confidence::float from facts where id=$1`, [claim.promotedFactId]);
      await client.query('commit');
      return {
        claimId,
        entityId: claim.targetEntityId,
        factId: claim.promotedFactId,
        outcome: 'confirmed',
        confidence: existing.rows[0]?.confidence ?? claim.confidence,
        conflictingFactIds: []
      };
    }

    const sourceId = `crawl_${claim.documentId}`;
    const authorityScore = Number(claim.authorityScore ?? 0.65);
    await client.query(
      `insert into sources (id, name, url, type, authority_score, retrieved_at)
       values ($1,$2,$3,$6,$4,$5)
       on conflict (id) do update set name=excluded.name, url=excluded.url,
         authority_score=excluded.authority_score, retrieved_at=excluded.retrieved_at`,
      [sourceId, claim.title || new URL(claim.url).hostname, claim.url, authorityScore, claim.fetchedAt, claim.sourceType ?? 'public']
    );

    const finalConfidence = Math.min(0.99, Math.max(0.05,
      Number((claim.confidence * 0.65 + authorityScore * 0.25 + 0.10).toFixed(3))
    ));

    const samePredicate = await client.query(
      `select f.id, f.value, f.confidence::float, f.status, f.version_group_id as "versionGroupId",
              f.version_no as "versionNo", f.is_current as "isCurrent",
              exists(select 1 from fact_sources fs where fs.fact_id=f.id and fs.source_id=$3) as "sameSource"
         from facts f
        where f.subject_entity_id=$1 and f.predicate=$2 and f.is_current=true
        order by f.created_at asc
        for update`,
      [claim.targetEntityId, claim.predicate, sourceId]
    );
    const exact = samePredicate.rows.find((row) => JSON.stringify(row.value) === JSON.stringify(claim.value));

    let factId: string;
    let outcome: PromoteClaimResult['outcome'];
    let confidence = finalConfidence;
    let conflictingFactIds: string[] = [];

    if (exact) {
      factId = exact.id;
      outcome = 'confirmed';
      confidence = Math.min(0.99, Number((Math.max(exact.confidence, finalConfidence) + 0.03).toFixed(3)));
      await client.query(
        `update facts set confidence=$2, status=case when status='conflicting' then status else 'verified' end,
                          last_checked=now() where id=$1`,
        [factId, confidence]
      );
      await client.query(
        `insert into fact_versions (fact_id,version_group_id,version_no,subject_entity_id,predicate,value,confidence,status,is_current,valid_from,valid_to,superseded_by_fact_id,change_type,source_id,claim_id)
         select id,version_group_id,version_no,subject_entity_id,predicate,value,$2,status,is_current,valid_from,valid_to,superseded_by_fact_id,'confirmed',$3,$4 from facts where id=$1`,
        [factId, confidence, sourceId, claimId]
      );
    } else {
      const sameSourceCurrent = samePredicate.rows.filter((row) => row.sameSource);
      outcome = sameSourceCurrent.length ? 'superseded' : (samePredicate.rows.length ? 'conflict' : 'created');
      conflictingFactIds = outcome === 'conflict' ? samePredicate.rows.map((row) => row.id) : [];

      let versionGroupId = crypto.randomUUID();
      let versionNo = 1;
      if (outcome === 'superseded') {
        const previous = sameSourceCurrent.sort((a,b) => Number(b.versionNo)-Number(a.versionNo))[0];
        versionGroupId = previous.versionGroupId;
        versionNo = Number(previous.versionNo) + 1;
      }

      factId = `fact_claim_${crypto.randomUUID()}`;
      await client.query(
        `insert into facts (id, subject_entity_id, predicate, value, confidence, status, last_checked,
                            valid_from, version_group_id, version_no, is_current)
         values ($1,$2,$3,$4::jsonb,$5,$6,now(),coalesce($7,now()),$8,$9,true)`,
        [factId, claim.targetEntityId, claim.predicate, JSON.stringify(claim.value), confidence,
         outcome === 'conflict' ? 'conflicting' : 'verified', claim.fetchedAt, versionGroupId, versionNo]
      );

      if (outcome === 'superseded') {
        for (const previous of sameSourceCurrent) {
          await client.query(
            `update facts set is_current=false, valid_to=coalesce($2,now()), superseded_by_fact_id=$3, last_checked=now() where id=$1`,
            [previous.id, claim.fetchedAt, factId]
          );
          await client.query(
            `insert into fact_versions (fact_id,version_group_id,version_no,subject_entity_id,predicate,value,confidence,status,is_current,valid_from,valid_to,superseded_by_fact_id,change_type,source_id,claim_id)
             select id,version_group_id,version_no,subject_entity_id,predicate,value,confidence,status,false,valid_from,valid_to,superseded_by_fact_id,'superseded',$2,$3 from facts where id=$1`,
            [previous.id, sourceId, claimId]
          );
        }
      } else if (outcome === 'conflict') {
        await client.query(
          `update facts set status='conflicting', last_checked=now()
            where subject_entity_id=$1 and predicate=$2 and is_current=true`,
          [claim.targetEntityId, claim.predicate]
        );
      }

      await client.query(
        `insert into fact_versions (fact_id,version_group_id,version_no,subject_entity_id,predicate,value,confidence,status,is_current,valid_from,valid_to,superseded_by_fact_id,change_type,source_id,claim_id)
         select id,version_group_id,version_no,subject_entity_id,predicate,value,confidence,status,is_current,valid_from,valid_to,superseded_by_fact_id,$2,$3,$4 from facts where id=$1`,
        [factId, outcome === 'superseded' ? 'created_from_supersession' : outcome, sourceId, claimId]
      );
    }

    await client.query(
      `insert into fact_sources (fact_id, source_id, evidence)
       values ($1,$2,$3)
       on conflict (fact_id, source_id) do update set evidence=excluded.evidence`,
      [factId, sourceId, claim.evidence ?? null]
    );
    await client.query(
      `update extracted_claims set promoted_fact_id=$2, promoted_at=now() where id=$1`,
      [claimId, factId]
    );
    await client.query(`update entities set updated_at=now() where id=$1`, [claim.targetEntityId]);
    await client.query('commit');
    return { claimId, entityId: claim.targetEntityId, factId, outcome, confidence, conflictingFactIds };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function normalizeEntityText(value: string) {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function tokenSet(value: string) {
  return new Set(value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap++;
  return overlap / (a.size + b.size - overlap);
}

export async function addEntityAliasDb(input: { entityId: string; alias: string; source?: string; confidence?: number }) {
  if (!pool) return null;
  const normalized = normalizeEntityText(input.alias);
  if (!normalized) return null;
  const result = await pool.query(
    `insert into entity_aliases (entity_id, alias, normalized_alias, source, confidence)
     values ($1,$2,$3,$4,$5)
     on conflict (entity_id, normalized_alias) do update set
       alias=excluded.alias, source=excluded.source, confidence=greatest(entity_aliases.confidence, excluded.confidence)
     returning id, entity_id as "entityId", alias, normalized_alias as "normalizedAlias", source,
               confidence::float, created_at as "createdAt"`,
    [input.entityId, input.alias, normalized, input.source ?? 'system', input.confidence ?? 1]
  );
  return result.rows[0] ?? null;
}

export async function listEntityAliasesDb(entityId: string) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, entity_id as "entityId", alias, normalized_alias as "normalizedAlias", source,
            confidence::float, created_at as "createdAt"
       from entity_aliases where entity_id=$1 order by confidence desc, alias`,
    [entityId]
  );
  return result.rows;
}

export async function resolveEntityCandidatesDb(subjectName: string, limit = 5) {
  if (!pool) return [];
  const normalized = normalizeEntityText(subjectName);
  const queryTokens = tokenSet(subjectName);
  if (!normalized) return [];

  const result = await pool.query(
    `select e.id, e.slug, e.type, e.name, e.summary, e.location,
            coalesce(json_agg(json_build_object('alias',a.alias,'normalizedAlias',a.normalized_alias,'confidence',a.confidence::float))
              filter (where a.id is not null), '[]'::json) as aliases,
            greatest(
              similarity(lower(e.name), lower($1)),
              coalesce(max(similarity(a.normalized_alias, $2)), 0)
            )::float as "dbSimilarity"
       from entities e
       left join entity_aliases a on a.entity_id=e.id
      group by e.id
      order by "dbSimilarity" desc
      limit 50`,
    [subjectName, normalized]
  );

  return result.rows.map((row) => {
    const canonicalNorm = normalizeEntityText(row.name);
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    const exactCanonical = canonicalNorm === normalized;
    const exactAlias = aliases.some((a: any) => a.normalizedAlias === normalized);
    const tokenScore = Math.max(
      jaccard(queryTokens, tokenSet(row.name)),
      ...aliases.map((a: any) => jaccard(queryTokens, tokenSet(String(a.alias ?? '')))),
      0
    );
    const containment = canonicalNorm.includes(normalized) || normalized.includes(canonicalNorm) ? 0.88 : 0;
    const aliasConfidence = Math.max(...aliases
      .filter((a: any) => a.normalizedAlias === normalized)
      .map((a: any) => Number(a.confidence ?? 0)), 0);
    const score = exactCanonical
      ? 1
      : exactAlias
        ? Math.min(0.99, 0.94 + aliasConfidence * 0.05)
        : Math.min(0.93, Math.max(Number(row.dbSimilarity ?? 0), tokenScore * 0.9, containment));
    return {
      id: row.id,
      slug: row.slug,
      type: row.type,
      name: row.name,
      summary: row.summary,
      location: row.location,
      score: Number(score.toFixed(4)),
      matchReason: {
        exactCanonical,
        exactAlias,
        tokenScore: Number(tokenScore.toFixed(4)),
        dbSimilarity: Number(row.dbSimilarity ?? 0).toFixed(4),
        containment: containment > 0
      }
    };
  }).filter((row) => row.score >= 0.25).sort((a,b) => b.score-a.score).slice(0, limit);
}

export async function saveResolutionCandidatesDb(claimId: string, subjectName: string, candidates: Array<{id:string;score:number;matchReason:Record<string,unknown>}>) {
  if (!pool) return [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from entity_resolution_candidates where claim_id=$1 and status='pending'`, [claimId]);
    const rows = [];
    for (const candidate of candidates) {
      const result = await client.query(
        `insert into entity_resolution_candidates (claim_id, subject_name, candidate_entity_id, score, match_reason)
         values ($1,$2,$3,$4,$5::jsonb)
         on conflict (claim_id, candidate_entity_id) do update set score=excluded.score, match_reason=excluded.match_reason
         returning id, claim_id as "claimId", subject_name as "subjectName", candidate_entity_id as "candidateEntityId",
                   score::float, match_reason as "matchReason", status, created_at as "createdAt"`,
        [claimId, subjectName, candidate.id, candidate.score, JSON.stringify(candidate.matchReason)]
      );
      rows.push(result.rows[0]);
    }
    await client.query('commit');
    return rows;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveClaimEntityDb(claimId: string) {
  if (!pool) return null;
  const claimResult = await pool.query(
    `select id, subject_name as "subjectName", target_entity_id as "targetEntityId", status
       from extracted_claims where id=$1`,
    [claimId]
  );
  const claim = claimResult.rows[0];
  if (!claim) return null;
  if (claim.targetEntityId) return { claimId, subjectName: claim.subjectName, autoResolved: true, selected: { id: claim.targetEntityId, score: 1 }, candidates: [] };
  if (!claim.subjectName) return { claimId, subjectName: null, autoResolved: false, selected: null, candidates: [] };

  const candidates = await resolveEntityCandidatesDb(claim.subjectName, 5);
  await saveResolutionCandidatesDb(claimId, claim.subjectName, candidates);
  const first = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const margin = first ? first.score - (second?.score ?? 0) : 0;
  const autoResolved = Boolean(first && first.score >= 0.94 && margin >= 0.08);

  if (autoResolved && first) {
    await pool.query(`update extracted_claims set target_entity_id=$2 where id=$1 and target_entity_id is null`, [claimId, first.id]);
    await pool.query(
      `update entity_resolution_candidates set status=case when candidate_entity_id=$2 then 'accepted' else 'rejected' end,
              resolved_at=now() where claim_id=$1 and status='pending'`,
      [claimId, first.id]
    );
  }

  return { claimId, subjectName: claim.subjectName, autoResolved, selected: autoResolved ? first : null, candidates };
}


export async function recomputeFactConfidenceDb(factId: string, reason = 'manual_recompute') {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const factResult = await client.query(
      `select f.id, f.subject_entity_id as "entityId", f.predicate, f.value, f.confidence::float as "currentConfidence",
              f.status, f.last_checked as "lastChecked",
              coalesce(json_agg(distinct jsonb_build_object(
                'authorityScore', s.authority_score::float,
                'retrievedAt', s.retrieved_at,
                'type', s.type
              )) filter (where s.id is not null), '[]'::json) as sources,
              count(distinct fs.source_id)::int as "supportingSourceCount"
         from facts f
         left join fact_sources fs on fs.fact_id=f.id
         left join sources s on s.id=fs.source_id
        where f.id=$1
        group by f.id`,
      [factId]
    );
    if (!factResult.rowCount) { await client.query('rollback'); return null; }
    const fact = factResult.rows[0];

    const conflictResult = await client.query(
      `select count(distinct fs.source_id)::int as count
         from facts other
         left join fact_sources fs on fs.fact_id=other.id
        where other.subject_entity_id=$1
          and other.predicate=$2
          and other.is_current=true
          and other.id<>$3
          and other.value<>$4::jsonb`,
      [fact.entityId, fact.predicate, fact.id, JSON.stringify(fact.value)]
    );

    const agentResult = await client.query(
      `select max(a.reputation)::float as reputation
         from extracted_claims c
         join agents a on a.id=c.reviewed_by_agent_id
        where c.promoted_fact_id=$1 and a.verified=true`,
      [factId]
    );

    const breakdown = calculateConfidence({
      claimConfidence: Number(fact.currentConfidence ?? 0.5),
      sources: Array.isArray(fact.sources) ? fact.sources : [],
      supportingSourceCount: Number(fact.supportingSourceCount ?? 0),
      conflictingSourceCount: Number(conflictResult.rows[0]?.count ?? 0),
      verifiedAgentReputation: agentResult.rows[0]?.reputation ?? null,
      lastChecked: fact.lastChecked
    });

    const nextStatus = Number(conflictResult.rows[0]?.count ?? 0) > 0 ? 'conflicting' : fact.status === 'unknown' ? 'observed' : fact.status;
    await client.query(
      `update facts set confidence=$2, status=$3, last_checked=now() where id=$1`,
      [factId, breakdown.score, nextStatus]
    );
    await client.query(
      `insert into fact_confidence_snapshots (fact_id, score, components, reason) values ($1,$2,$3::jsonb,$4)`,
      [factId, breakdown.score, JSON.stringify(breakdown.components), reason]
    );
    await client.query('commit');
    return { factId, entityId: fact.entityId, score: breakdown.score, status: nextStatus, components: breakdown.components };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function recomputeEntityConfidenceDb(entityId: string) {
  if (!pool) return null;
  const ids = await pool.query(`select id from facts where subject_entity_id=$1 order by id`, [entityId]);
  const facts = [];
  for (const row of ids.rows) {
    const result = await recomputeFactConfidenceDb(row.id, 'entity_recompute');
    if (result) facts.push(result);
  }
  const scoreResult = await pool.query(
    `select avg(confidence)::float as score, count(*)::int as facts,
            count(*) filter (where status='conflicting')::int as conflicts
       from facts where subject_entity_id=$1`,
    [entityId]
  );
  const row = scoreResult.rows[0];
  return {
    entityId,
    score: row?.score == null ? null : Number(Number(row.score).toFixed(3)),
    facts: Number(row?.facts ?? 0),
    conflicts: Number(row?.conflicts ?? 0),
    breakdown: facts
  };
}

export async function getFactConfidenceHistoryDb(factId: string, limit = 20) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, fact_id as "factId", score::float, components, reason, created_at as "createdAt"
       from fact_confidence_snapshots where fact_id=$1 order by created_at desc limit $2`,
    [factId, limit]
  );
  return result.rows;
}

export async function listKnownCitiesDb() {
  if (!pool) return [] as string[];
  const result = await pool.query(`select name from entities where type='city' order by name`);
  return result.rows.map((row) => String(row.name));
}

export async function hybridRetrieveDb(intent: QueryIntent, limit = 10) {
  if (!pool) return [];
  const result = await pool.query(
    `select e.id, e.slug, e.type, e.name, e.summary, e.location,
            e.updated_at as "updatedAt",
            coalesce(avg(f.confidence),0)::float as confidence,
            coalesce(json_agg(distinct jsonb_build_object(
              'id', f.id,
              'predicate', f.predicate,
              'value', f.value,
              'confidence', f.confidence::float,
              'status', f.status,
              'lastChecked', f.last_checked
            )) filter (where f.id is not null), '[]'::json) as facts,
            coalesce(json_agg(distinct jsonb_build_object(
              'id', s.id,
              'name', s.name,
              'url', s.url,
              'type', s.type,
              'authorityScore', s.authority_score::float,
              'retrievedAt', s.retrieved_at
            )) filter (where s.id is not null), '[]'::json) as sources
       from entities e
       left join facts f on f.subject_entity_id=e.id and f.is_current=true
       left join fact_sources fs on fs.fact_id=f.id
       left join sources s on s.id=fs.source_id
      group by e.id
      order by e.updated_at desc`
  );

  const queryTerms = new Set(intent.tokens.map(normalizeQuery).filter(Boolean));
  const facetVocabulary = intent.facets.flatMap(facetTerms);

  const scored = result.rows.map((row) => {
    const facts = Array.isArray(row.facts) ? row.facts : [];
    const sources = Array.isArray(row.sources) ? row.sources : [];
    const searchable = normalizeQuery([
      row.name,
      row.summary,
      JSON.stringify(row.location ?? {}),
      ...facts.flatMap((f: any) => [f.predicate, JSON.stringify(f.value)])
    ].join(' '));
    const searchableTokens = new Set(searchable.split(' ').filter(Boolean));

    let lexicalHits = 0;
    for (const token of queryTerms) {
      if (searchableTokens.has(token) || searchable.includes(token)) lexicalHits++;
    }
    const lexical = queryTerms.size ? lexicalHits / queryTerms.size : 0;

    const facetHits = facetVocabulary.filter((term) => searchable.includes(term)).length;
    const facetScore = facetVocabulary.length ? Math.min(1, facetHits / Math.max(1, intent.facets.length)) : 0;

    const cityName = normalizeQuery(String(row.location?.city ?? ''));
    const cityScore = intent.city
      ? (cityName === normalizeQuery(intent.city) || normalizeQuery(String(row.name)) === normalizeQuery(intent.city) ? 1 : 0)
      : 0.5;

    const typeScore = intent.typeHints.length
      ? (intent.typeHints.includes(row.type) ? 1 : 0)
      : 0.5;

    const trust = Math.max(0, Math.min(1, Number(row.confidence ?? 0)));
    const freshnessDays = Math.max(0, (Date.now() - new Date(row.updatedAt).getTime()) / 86400000);
    const freshness = Math.max(0.35, Math.exp(-freshnessDays / 365));

    const exactName = normalizeQuery(String(row.name)) === intent.normalized ? 1 : 0;
    const nameContains = intent.normalized && normalizeQuery(String(row.name)).includes(intent.normalized) ? 1 : 0;

    const score = Math.min(1,
      exactName * 0.34 +
      nameContains * 0.12 +
      lexical * 0.25 +
      facetScore * 0.10 +
      cityScore * 0.07 +
      typeScore * 0.05 +
      trust * 0.05 +
      freshness * 0.02
    );

    const matchedFacts = facts
      .filter((f: any) => {
        const text = normalizeQuery(`${f.predicate} ${JSON.stringify(f.value)}`);
        return [...queryTerms].some((t) => text.includes(t)) || facetVocabulary.some((t) => text.includes(t));
      })
      .sort((a: any,b: any) => Number(b.confidence ?? 0)-Number(a.confidence ?? 0))
      .slice(0, 8);

    return {
      id: row.id,
      slug: row.slug,
      type: row.type,
      name: row.name,
      summary: row.summary,
      location: row.location,
      confidence: trust,
      updatedAt: row.updatedAt,
      score: Number(score.toFixed(4)),
      reasons: {
        lexical: Number(lexical.toFixed(3)),
        facets: Number(facetScore.toFixed(3)),
        city: cityScore,
        type: typeScore,
        trust: Number(trust.toFixed(3)),
        freshness: Number(freshness.toFixed(3))
      },
      facts: matchedFacts.length ? matchedFacts : facts.slice(0, 5),
      sources: sources.slice(0, 5)
    };
  });

  return scored
    .filter((row) => row.score >= 0.08)
    .sort((a,b) => b.score-a.score || b.confidence-a.confidence)
    .slice(0, limit);
}


export async function buildEntityEmbeddingTextDb(entityId: string) {
  if (!pool) return null;
  const result = await pool.query(
    `select e.id, e.name, e.type, e.summary, e.location,
            coalesce(string_agg(distinct a.alias, ' | '), '') as aliases,
            coalesce(string_agg(distinct (f.predicate || ': ' || f.value::text), ' | '), '') as facts
       from entities e
       left join entity_aliases a on a.entity_id=e.id
       left join facts f on f.subject_entity_id=e.id and f.is_current=true and f.status <> 'unknown'
      where e.id=$1
      group by e.id`, [entityId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return [row.name, `type:${row.type}`, row.summary, JSON.stringify(row.location ?? {}), row.aliases, row.facts]
    .filter(Boolean).join('\n');
}

export async function refreshEntityEmbeddingDb(entityId: string) {
  if (!pool) return null;
  const text = await buildEntityEmbeddingTextDb(entityId);
  if (!text) return null;
  const hash = contentHash(text);
  const model = embeddingModel();
  const existing = await pool.query(`select content_hash as "contentHash", model from entity_embeddings where entity_id=$1`, [entityId]);
  if (existing.rows[0]?.contentHash === hash && existing.rows[0]?.model === model) {
    return { entityId, model, skipped: true };
  }
  const vector = await embedText(text);
  await pool.query(
    `insert into entity_embeddings (entity_id, model, dimensions, vector, content_hash, embedded_at, updated_at)
     values ($1,$2,$3,$4,$5,now(),now())
     on conflict (entity_id) do update set model=excluded.model, dimensions=excluded.dimensions,
       vector=excluded.vector, content_hash=excluded.content_hash, embedded_at=now(), updated_at=now()`,
    [entityId, model, vector.length, vector, hash]
  );
  return { entityId, model, dimensions: vector.length, skipped: false };
}

export async function refreshAllEntityEmbeddingsDb() {
  if (!pool) return [];
  const ids = await pool.query(`select id from entities order by id`);
  const results = [];
  for (const row of ids.rows) results.push(await refreshEntityEmbeddingDb(row.id));
  return results;
}

export async function semanticSearchEntitiesDb(query: string, limit = 10) {
  if (!pool) return [];
  const queryVector = await embedText(query);
  const result = await pool.query(
    `select ee.entity_id as "entityId", ee.vector, ee.model,
            e.id, e.slug, e.type, e.name, e.summary, e.location, e.updated_at as "updatedAt",
            coalesce(avg(f.confidence),0)::float as confidence
       from entity_embeddings ee
       join entities e on e.id=ee.entity_id
       left join facts f on f.subject_entity_id=e.id and f.is_current=true
      where ee.model=$1
      group by ee.entity_id, ee.vector, ee.model, e.id
      limit 5000`, [embeddingModel()]
  );
  return result.rows.map((row) => {
    const vector = Array.isArray(row.vector) ? row.vector.map(Number) : [];
    return { ...row, vector: undefined, semanticScore: cosineSimilarity(queryVector, vector) };
  }).sort((a,b) => b.semanticScore-a.semanticScore).slice(0, limit);
}

export async function semanticHybridRetrieveDb(intent: QueryIntent, limit = 10) {
  const lexical = await hybridRetrieveDb(intent, Math.max(limit * 3, 20));
  let semantic: any[] = [];
  try {
    semantic = await semanticSearchEntitiesDb(intent.raw, Math.max(limit * 3, 20));
  } catch {
    return lexical.slice(0, limit).map((row) => ({ ...row, semanticScore: null, retrievalScore: row.score }));
  }

  const semanticById = new Map(semantic.map((row) => [row.id, row]));
  const lexicalById = new Map(lexical.map((row) => [row.id, row]));
  const ids = new Set([...lexicalById.keys(), ...semanticById.keys()]);
  const merged = [] as any[];

  for (const id of ids) {
    const l = lexicalById.get(id);
    const s = semanticById.get(id);
    const semanticScore = Math.max(0, Math.min(1, Number(s?.semanticScore ?? 0)));
    const lexicalScore = Math.max(0, Math.min(1, Number(l?.score ?? 0)));
    const trust = Math.max(0, Math.min(1, Number(l?.confidence ?? s?.confidence ?? 0)));
    const cityBoost = Number(l?.reasons?.city ?? 0) === 1 ? 0.04 : 0;
    const typeBoost = Number(l?.reasons?.type ?? 0) === 1 ? 0.025 : 0;
    const retrievalScore = Math.min(1, semanticScore * 0.58 + lexicalScore * 0.32 + trust * 0.10 + cityBoost + typeBoost);

    let base = l;
    if (!base && s) {
      const full = await getEntityDb(s.id);
      base = {
        id: s.id, slug: s.slug, type: s.type, name: s.name, summary: s.summary,
        location: s.location, confidence: Number(s.confidence ?? 0), updatedAt: s.updatedAt,
        score: 0, reasons: { lexical: 0, facets: 0, city: 0, type: 0, trust: Number(s.confidence ?? 0), freshness: 1 },
        facts: full?.facts?.slice(0, 5) ?? [], sources: full?.sources?.slice(0, 5) ?? []
      };
    }
    if (!base) continue;
    if (intent.city) {
      const expectedCity = normalizeQuery(intent.city);
      const entityCity = normalizeQuery(String(base.location?.city ?? ''));
      const entityName = normalizeQuery(String(base.name ?? ''));
      if (entityCity !== expectedCity && entityName !== expectedCity) continue;
    }
    merged.push({
      ...base,
      semanticScore: Number(semanticScore.toFixed(4)),
      lexicalScore: Number(lexicalScore.toFixed(4)),
      retrievalScore: Number(retrievalScore.toFixed(4)),
      score: Number(retrievalScore.toFixed(4)),
      reasons: { ...base.reasons, semantic: Number(semanticScore.toFixed(3)) }
    });
  }

  return merged.sort((a,b) => b.retrievalScore-a.retrievalScore || b.confidence-a.confidence).slice(0, limit);
}

export async function createSourceRegistryDb(input: {name:string;baseUrl:string;sourceType?:string;authorityScore?:number;maxPagesPerRun?:number;crawlDelayMs?:number;respectRobots?:boolean}) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into source_registry (name, base_url, source_type, authority_score, max_pages_per_run, crawl_delay_ms, respect_robots)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (base_url) do update set name=excluded.name, source_type=excluded.source_type,
       authority_score=excluded.authority_score, max_pages_per_run=excluded.max_pages_per_run,
       crawl_delay_ms=excluded.crawl_delay_ms, respect_robots=excluded.respect_robots, updated_at=now()
     returning id, name, base_url as "baseUrl", source_type as "sourceType", authority_score::float as "authorityScore",
       crawl_enabled as "crawlEnabled", respect_robots as "respectRobots", max_pages_per_run as "maxPagesPerRun",
       crawl_delay_ms as "crawlDelayMs", last_crawled_at as "lastCrawledAt"`,
    [input.name,input.baseUrl,input.sourceType??'public',input.authorityScore??0.5,input.maxPagesPerRun??25,input.crawlDelayMs??1200,input.respectRobots??true]
  );
  return result.rows[0] ?? null;
}

export async function listSourceRegistryDb() {
  if (!pool) return [];
  const result = await pool.query(`select id, name, base_url as "baseUrl", source_type as "sourceType",
    authority_score::float as "authorityScore", crawl_enabled as "crawlEnabled", respect_robots as "respectRobots",
    max_pages_per_run as "maxPagesPerRun", crawl_delay_ms as "crawlDelayMs", last_crawled_at as "lastCrawledAt"
    from source_registry order by authority_score desc, name`);
  return result.rows;
}

export async function getSourceRegistryDb(id:string) {
  if (!pool) return null;
  const result = await pool.query(`select id, name, base_url as "baseUrl", source_type as "sourceType",
    authority_score::float as "authorityScore", crawl_enabled as "crawlEnabled", respect_robots as "respectRobots",
    max_pages_per_run as "maxPagesPerRun", crawl_delay_ms as "crawlDelayMs", last_crawled_at as "lastCrawledAt"
    from source_registry where id=$1`, [id]);
  return result.rows[0] ?? null;
}

export async function enqueueSourceUrlDb(sourceRegistryId:string, url:string, depth=0, discoveredFrom?:string) {
  if (!pool) return null;
  const result = await pool.query(`insert into source_frontier (source_registry_id,url,depth,discovered_from)
    values ($1,$2,$3,$4) on conflict (source_registry_id,url) do update set updated_at=now()
    returning id, source_registry_id as "sourceRegistryId", url, depth, status, discovered_from as "discoveredFrom"`,
    [sourceRegistryId,url,depth,discoveredFrom??null]);
  return result.rows[0] ?? null;
}

export async function claimSourceFrontierBatchDb(sourceRegistryId:string, limit:number) {
  if (!pool) return [];
  const result = await pool.query(`with picked as (
      select id from source_frontier where source_registry_id=$1 and status='queued'
      order by depth asc, created_at asc limit $2 for update skip locked
    )
    update source_frontier f set status='running', updated_at=now()
    from picked where f.id=picked.id
    returning f.id, f.url, f.depth, f.discovered_from as "discoveredFrom"`, [sourceRegistryId,limit]);
  return result.rows;
}

export async function finishSourceFrontierDb(id:string, status:'completed'|'failed'|'blocked', error?:string) {
  if (!pool) return null;
  const result = await pool.query(`update source_frontier set status=$2,last_error=$3,last_crawled_at=now(),updated_at=now() where id=$1
    returning id,url,status,last_error as "lastError",last_crawled_at as "lastCrawledAt"`, [id,status,error??null]);
  return result.rows[0] ?? null;
}

export async function markSourceRegistryCrawledDb(id:string) {
  if (!pool) return null;
  const result = await pool.query(`update source_registry set last_crawled_at=now(),updated_at=now() where id=$1 returning id,last_crawled_at as "lastCrawledAt"`,[id]);
  return result.rows[0] ?? null;
}

const AUTO_REVIEW_POLICY_VERSION = 'official-strict-v1';
const AUTO_REVIEW_PREDICATES = new Set([
  'schema:name',
  'schema:description',
  'schema:address',
  'schema:telephone',
  'schema:email',
  'schema:url',
  'schema:openingHours',
  'schema:servesCuisine',
  'schema:priceRange'
]);

export async function autoReviewPendingClaimsDb(sourceRegistryId?: string, limit = 200) {
  if (!pool) return null;
  const params: unknown[] = [];
  let sourceFilter = '';
  if (sourceRegistryId) {
    params.push(sourceRegistryId);
    sourceFilter = ` and d.source_registry_id=$${params.length}`;
  }
  params.push(limit);
  const claimsResult = await pool.query(
    `select c.id, c.subject_name as "subjectName", c.predicate, c.value, c.confidence::float,
            c.target_entity_id as "targetEntityId", d.source_registry_id as "sourceRegistryId",
            sr.source_type as "sourceType", sr.authority_score::float as "authorityScore",
            coalesce((select max(rc.score)::float from entity_resolution_candidates rc
                      where rc.claim_id=c.id and rc.status='accepted'),
                     case when c.auto_entity_created or exists (
                       select 1 from entity_creation_audit eca where eca.entity_id=c.target_entity_id
                     ) then 1.0 else 0 end)::float as "resolutionScore"
       from extracted_claims c
       join source_documents d on d.id=c.document_id
       left join source_registry sr on sr.id=d.source_registry_id
      where c.status='pending' ${sourceFilter}
      order by c.confidence desc, c.created_at asc
      limit $${params.length}`,
    params
  );

  const stats = { examined: 0, accepted: 0, deferred: 0, conflicted: 0, promoted: 0, policyVersion: AUTO_REVIEW_POLICY_VERSION };
  const decisions: Array<Record<string, unknown>> = [];

  for (const claim of claimsResult.rows) {
    stats.examined++;
    const reasons = {
      officialSource: claim.sourceType === 'official',
      authorityScore: Number(claim.authorityScore ?? 0),
      extractionConfidence: Number(claim.confidence ?? 0),
      resolutionScore: Number(claim.resolutionScore ?? 0),
      predicateAllowed: AUTO_REVIEW_PREDICATES.has(claim.predicate),
      hasTargetEntity: Boolean(claim.targetEntityId)
    };

    const eligible = reasons.officialSource &&
      reasons.authorityScore >= 0.9 &&
      reasons.extractionConfidence >= 0.88 &&
      reasons.resolutionScore >= 0.94 &&
      reasons.predicateAllowed &&
      reasons.hasTargetEntity;

    if (!eligible) {
      stats.deferred++;
      decisions.push({ claimId: claim.id, decision: 'deferred', reasons });
      continue;
    }

    const conflicts = await pool.query(
      `select id from facts where subject_entity_id=$1 and predicate=$2 and is_current=true and value<>$3::jsonb limit 5`,
      [claim.targetEntityId, claim.predicate, JSON.stringify(claim.value)]
    );
    if (conflicts.rowCount) {
      await pool.query(
        `update extracted_claims
            set status='conflicting', auto_reviewed=true, auto_review_policy=$2,
                auto_review_reason=$3::jsonb, reviewed_at=now(), reviewed_by_agent_id='agentbase-verifier',
                review_note='Automatic review detected an existing conflicting fact.'
          where id=$1 and status='pending'`,
        [claim.id, AUTO_REVIEW_POLICY_VERSION, JSON.stringify({ ...reasons, conflictingFactIds: conflicts.rows.map((r) => r.id) })]
      );
      stats.conflicted++;
      decisions.push({ claimId: claim.id, decision: 'conflicting', reasons, conflictingFactIds: conflicts.rows.map((r) => r.id) });
      continue;
    }

    const accepted = await pool.query(
      `update extracted_claims
          set status='accepted', auto_reviewed=true, auto_review_policy=$2,
              auto_review_reason=$3::jsonb, reviewed_at=now(), reviewed_by_agent_id='agentbase-verifier',
              review_note='Automatically accepted by strict official-source policy.'
        where id=$1 and status='pending'
        returning id`,
      [claim.id, AUTO_REVIEW_POLICY_VERSION, JSON.stringify(reasons)]
    );
    if (!accepted.rowCount) continue;
    stats.accepted++;
    const promotion = await promoteAcceptedClaimToFactDb(claim.id);
    if (promotion) {
      stats.promoted++;
      await recomputeFactConfidenceDb(promotion.factId, 'auto_review_promotion');
      await refreshEntityEmbeddingDb(promotion.entityId);
    }
    decisions.push({ claimId: claim.id, decision: 'accepted', reasons, promotion });
  }

  const run = await pool.query(
    `insert into auto_review_runs (source_registry_id, examined, accepted, deferred, conflicted, policy_version, details)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)
     returning id, source_registry_id as "sourceRegistryId", examined, accepted, deferred, conflicted,
               policy_version as "policyVersion", created_at as "createdAt"`,
    [sourceRegistryId ?? null, stats.examined, stats.accepted, stats.deferred, stats.conflicted, AUTO_REVIEW_POLICY_VERSION, JSON.stringify({ promoted: stats.promoted })]
  );
  return { ...stats, run: run.rows[0], decisions };
}

export async function listAutoReviewRunsDb(limit = 20) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, source_registry_id as "sourceRegistryId", examined, accepted, deferred, conflicted,
            policy_version as "policyVersion", details, created_at as "createdAt"
       from auto_review_runs order by created_at desc limit $1`, [limit]
  );
  return result.rows;
}


const AUTO_ENTITY_POLICY_VERSION = 'official-structured-v1';
const AUTO_ENTITY_TYPE_MAP: Record<string, string> = {
  City: 'city',
  Place: 'place',
  TouristAttraction: 'place',
  Museum: 'place',
  Landmark: 'place',
  LocalBusiness: 'business',
  Restaurant: 'business',
  CafeOrCoffeeShop: 'business',
  FoodEstablishment: 'business',
  Hotel: 'business',
  Store: 'business',
  Event: 'event',
  FoodEvent: 'event',
  MusicEvent: 'event',
  ExhibitionEvent: 'event'
};

function entitySlug(value: string) {
  return value.toLocaleLowerCase('tr-TR').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'entity';
}

const GENERIC_ENTITY_NAMES = new Set(['ana sayfa','home','anasayfa','hizmetlerimiz','etkinlikler','duyurular','iletisim','iletişim']);

export async function autoCreateEntitiesDb(sourceRegistryId?: string, limit = 100) {
  if (!pool) return null;
  const params: unknown[] = [];
  let sourceFilter = '';
  if (sourceRegistryId) {
    params.push(sourceRegistryId);
    sourceFilter = ` and d.source_registry_id=$${params.length}`;
  }
  params.push(limit);
  const candidates = await pool.query(
    `select c.id, c.document_id as "documentId", c.subject_name as "subjectName", c.subject_type as "subjectType",
            c.value, c.confidence::float, d.source_registry_id as "sourceRegistryId",
            sr.source_type as "sourceType", sr.authority_score::float as "authorityScore"
       from extracted_claims c
       join source_documents d on d.id=c.document_id
       join source_registry sr on sr.id=d.source_registry_id
      where c.status='pending' and c.target_entity_id is null and c.predicate='schema:name'
        and c.subject_type is not null ${sourceFilter}
      order by sr.authority_score desc, c.confidence desc, c.created_at asc
      limit $${params.length}`,
    params
  );

  const stats = { examined: 0, created: 0, deferred: 0, duplicateRisk: 0, policyVersion: AUTO_ENTITY_POLICY_VERSION };
  const decisions: Array<Record<string, unknown>> = [];

  for (const claim of candidates.rows) {
    stats.examined++;
    const name = typeof claim.value === 'string' ? claim.value.trim() : String(claim.subjectName ?? '').trim();
    const entityType = AUTO_ENTITY_TYPE_MAP[String(claim.subjectType ?? '')];
    const normalizedName = name.toLocaleLowerCase('tr-TR').trim();
    const reasons: Record<string, unknown> = {
      officialSource: claim.sourceType === 'official', authorityScore: Number(claim.authorityScore ?? 0),
      extractionConfidence: Number(claim.confidence ?? 0), subjectType: claim.subjectType,
      mappedEntityType: entityType ?? null, validName: name.length >= 2 && name.length <= 160 && !GENERIC_ENTITY_NAMES.has(normalizedName)
    };
    if (!reasons.officialSource || Number(reasons.authorityScore) < 0.9 || Number(reasons.extractionConfidence) < 0.88 || !entityType || !reasons.validName) {
      stats.deferred++; decisions.push({ claimId: claim.id, decision: 'deferred', reasons }); continue;
    }

    const matches = await resolveEntityCandidatesDb(name, 5);
    const best = matches[0] ?? null;
    reasons.bestExistingMatch = best ? { id: best.id, name: best.name, score: best.score } : null;
    if (best && best.score >= 0.60) {
      stats.duplicateRisk++;
      decisions.push({ claimId: claim.id, decision: 'duplicate_risk', reasons });
      continue;
    }

    const sibling = await pool.query(
      `select predicate, value from extracted_claims where document_id=$1 and subject_name=$2 and status='pending'`,
      [claim.documentId, claim.subjectName]
    );
    const desc = sibling.rows.find((r) => r.predicate === 'schema:description')?.value;
    const address = sibling.rows.find((r) => r.predicate === 'schema:address')?.value;
    let location: Record<string, unknown> | null = null;
    if (address && typeof address === 'object' && !Array.isArray(address)) {
      const a = address as Record<string, unknown>;
      location = {
        ...(a.addressLocality ? { city: a.addressLocality } : {}),
        ...(a.addressRegion ? { region: a.addressRegion } : {}),
        ...(a.addressCountry ? { country: a.addressCountry } : {})
      };
      if (!Object.keys(location).length) location = null;
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      const entityId = `entity_${crypto.randomUUID()}`;
      const baseSlug = entitySlug(name);
      let slug = baseSlug;
      const slugTaken = await client.query(`select 1 from entities where slug=$1`, [slug]);
      if (slugTaken.rowCount) slug = `${baseSlug}-${entityId.slice(-8)}`;
      await client.query(
        `insert into entities (id,slug,type,name,summary,location) values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [entityId, slug, entityType, name, typeof desc === 'string' ? desc.slice(0,2000) : '', JSON.stringify(location)]
      );
      await client.query(
        `insert into entity_aliases (entity_id,alias,normalized_alias,source,confidence)
         values ($1,$2,$3,$4,1) on conflict (entity_id,normalized_alias) do nothing`,
        [entityId, name, normalizeEntityText(name), `auto:${AUTO_ENTITY_POLICY_VERSION}`]
      );
      await client.query(
        `update extracted_claims set target_entity_id=$2, auto_entity_created=true, created_entity_id=$2
          where id=$1 and status='pending'`, [claim.id, entityId]
      );
      await client.query(
        `update extracted_claims set target_entity_id=$3
          where document_id=$1 and subject_name=$2 and target_entity_id is null and status='pending'`,
        [claim.documentId, claim.subjectName, entityId]
      );
      await client.query(
        `insert into entity_creation_audit (claim_id,entity_id,source_registry_id,policy_version,decision)
         values ($1,$2,$3,$4,$5::jsonb)`,
        [claim.id, entityId, claim.sourceRegistryId, AUTO_ENTITY_POLICY_VERSION, JSON.stringify(reasons)]
      );
      await client.query('commit');
      stats.created++;
      decisions.push({ claimId: claim.id, decision: 'created', entityId, slug, entityType, reasons });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
  return { ...stats, decisions };
}

export async function listEntityCreationAuditDb(limit = 50) {
  if (!pool) return [];
  const result = await pool.query(
    `select a.id, a.claim_id as "claimId", a.entity_id as "entityId", e.name as "entityName", e.type as "entityType",
            a.source_registry_id as "sourceRegistryId", a.policy_version as "policyVersion", a.decision, a.created_at as "createdAt"
       from entity_creation_audit a join entities e on e.id=a.entity_id
      order by a.created_at desc limit $1`, [limit]
  );
  return result.rows;
}


export async function getFactHistoryDb(factId: string, limit = 50) {
  if (!pool) return [];
  const groupResult = await pool.query(`select version_group_id as "versionGroupId" from facts where id=$1`, [factId]);
  const versionGroupId = groupResult.rows[0]?.versionGroupId;
  if (!versionGroupId) return [];
  const result = await pool.query(
    `select id, fact_id as "factId", version_group_id as "versionGroupId", version_no as "versionNo",
            subject_entity_id as "entityId", predicate, value, confidence::float, status, is_current as "isCurrent",
            valid_from as "validFrom", valid_to as "validTo", superseded_by_fact_id as "supersededByFactId",
            change_type as "changeType", source_id as "sourceId", claim_id as "claimId", recorded_at as "recordedAt"
       from fact_versions where version_group_id=$1 order by version_no desc, recorded_at desc limit $2`,
    [versionGroupId, limit]
  );
  return result.rows;
}

export async function getEntityFactsAtDb(entityId: string, at: string) {
  if (!pool) return [];
  const result = await pool.query(
    `select id, predicate, value, confidence::float, status,
            version_group_id as "versionGroupId", version_no as "versionNo",
            valid_from as "validFrom", valid_to as "validTo"
       from facts
      where subject_entity_id=$1
        and coalesce(valid_from, created_at) <= $2::timestamptz
        and (valid_to is null or valid_to > $2::timestamptz)
      order by predicate, version_no desc`,
    [entityId, at]
  );
  return result.rows;
}

export type BackgroundJob = {
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: 'queued'|'running'|'completed'|'failed'|'cancelled';
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt: string | null;
  lockedBy: string | null;
  lastError: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export async function enqueueBackgroundJobDb(jobType: string, payload: Record<string, unknown>, options?: { priority?: number; maxAttempts?: number; runAfter?: string }) {
  if (!pool) return null;
  const result = await pool.query(
    `insert into background_jobs (job_type,payload,priority,max_attempts,run_after)
     values ($1,$2::jsonb,$3,$4,coalesce($5::timestamptz,now()))
     returning id, job_type as "jobType", payload, status, priority, attempts, max_attempts as "maxAttempts",
       run_after as "runAfter", locked_at as "lockedAt", locked_by as "lockedBy", last_error as "lastError",
       result, created_at as "createdAt", updated_at as "updatedAt", completed_at as "completedAt"`,
    [jobType, JSON.stringify(payload), options?.priority ?? 100, options?.maxAttempts ?? 3, options?.runAfter ?? null]
  );
  return result.rows[0] as BackgroundJob;
}

export async function claimBackgroundJobDb(workerId: string, jobTypes: string[] = []) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const params: unknown[] = [];
    let typeFilter = '';
    if (jobTypes.length) {
      params.push(jobTypes);
      typeFilter = ` and job_type = any($${params.length}::text[])`;
    }
    params.push(workerId);
    const result = await client.query(
      `with picked as (
         select id from background_jobs
          where ((status='queued' and run_after <= now()) or (status='running' and locked_at < now() - interval '30 minutes')) ${typeFilter}
          order by priority asc, created_at asc
          limit 1 for update skip locked
       )
       update background_jobs j
          set status='running', attempts=attempts+1, locked_at=now(), locked_by=$${params.length}, updated_at=now()
         from picked where j.id=picked.id
       returning j.id, j.job_type as "jobType", j.payload, j.status, j.priority, j.attempts,
         j.max_attempts as "maxAttempts", j.run_after as "runAfter", j.locked_at as "lockedAt",
         j.locked_by as "lockedBy", j.last_error as "lastError", j.result,
         j.created_at as "createdAt", j.updated_at as "updatedAt", j.completed_at as "completedAt"`, params);
    await client.query('commit');
    return (result.rows[0] ?? null) as BackgroundJob | null;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function completeBackgroundJobDb(id: string, resultValue: unknown) {
  if (!pool) return null;
  const result = await pool.query(
    `update background_jobs set status='completed', result=$2::jsonb, last_error=null,
       completed_at=now(), locked_at=null, locked_by=null, updated_at=now()
     where id=$1 returning id,status,completed_at as "completedAt"`, [id, JSON.stringify(resultValue ?? null)]);
  return result.rows[0] ?? null;
}

export async function failBackgroundJobDb(id: string, error: string, retryDelaySeconds = 30) {
  if (!pool) return null;
  const result = await pool.query(
    `update background_jobs
        set status=case when attempts < max_attempts then 'queued' else 'failed' end,
            run_after=case when attempts < max_attempts then now() + make_interval(secs => $3) else run_after end,
            last_error=$2, locked_at=null, locked_by=null, updated_at=now()
      where id=$1
      returning id,status,attempts,max_attempts as "maxAttempts",run_after as "runAfter",last_error as "lastError"`,
    [id, error.slice(0,2000), Math.max(1,retryDelaySeconds)]);
  return result.rows[0] ?? null;
}

export async function getBackgroundJobDb(id: string) {
  if (!pool) return null;
  const result = await pool.query(
    `select id, job_type as "jobType", payload, status, priority, attempts, max_attempts as "maxAttempts",
      run_after as "runAfter", locked_at as "lockedAt", locked_by as "lockedBy", last_error as "lastError",
      result, created_at as "createdAt", updated_at as "updatedAt", completed_at as "completedAt"
      from background_jobs where id=$1`, [id]);
  return result.rows[0] ?? null;
}

export async function listBackgroundJobsDb(limit = 50, status?: string) {
  if (!pool) return [];
  const params: unknown[] = [];
  let filter = '';
  if (status) { params.push(status); filter = ` where status=$${params.length}`; }
  params.push(limit);
  const result = await pool.query(
    `select id, job_type as "jobType", payload, status, priority, attempts, max_attempts as "maxAttempts",
      run_after as "runAfter", locked_at as "lockedAt", locked_by as "lockedBy", last_error as "lastError",
      result, created_at as "createdAt", updated_at as "updatedAt", completed_at as "completedAt"
      from background_jobs ${filter} order by created_at desc limit $${params.length}`, params);
  return result.rows;
}

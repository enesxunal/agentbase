import { createMcpHandler, McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
  createAgentEventDb,
  createAgentReviewDb,
  createContributionDb,
  getEntityAgentScoreDb,
  getEntityDb,
  getFactsDb,
  getRelationsDb,
  getSourcesDb,
  listKnownCitiesDb,
  searchEntitiesDb,
  semanticHybridRetrieveDb
} from './db.js';
import { parseQuery } from './retrieval.js';

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { data: value }
  };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

async function resolveEntity(idOrSlug: string) {
  const direct = await getEntityDb(idOrSlug);
  if (direct) return direct;
  const matches = await searchEntitiesDb(idOrSlug, undefined, 10);
  return matches.find((item) => item.slug === idOrSlug || item.name.toLocaleLowerCase('tr-TR') === idOrSlug.toLocaleLowerCase('tr-TR')) ?? null;
}

function createAgentBaseMcpServer(ctx: McpRequestContext) {
  const server = new McpServer(
    { name: 'agentbase', version: '0.5.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool('search', {
    description: 'AgentBase Türkiye bilgi ağında entity ve fact araması yapar.',
    inputSchema: z.object({
      query: z.string().min(1),
      type: z.string().optional(),
      limit: z.number().int().min(1).max(25).default(10)
    })
  }, async ({ query, type, limit }) => {
    const results = await searchEntitiesDb(query, type, limit);
    return toolResult({ query, results });
  });

  server.registerTool('retrieve', {
    description: 'Doğal dil sorgusunu intent, şehir, facet, semantic similarity ve güven sinyalleriyle çözümler.',
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(25).default(10)
    })
  }, async ({ query, limit }) => {
    const cities = await listKnownCitiesDb();
    const intent = parseQuery(query, cities);
    const results = await semanticHybridRetrieveDb(intent, limit);
    return toolResult({ query, retrievalMode: 'semantic-hybrid-v2', intent, results });
  });

  server.registerTool('get_entity', {
    description: 'Bir AgentBase entity kaydını canonical ID, slug veya tam ad ile getirir.',
    inputSchema: z.object({ id: z.string().min(1) })
  }, async ({ id }) => {
    const entity = await resolveEntity(id);
    return entity ? toolResult(entity) : toolError('entity_not_found');
  });

  server.registerTool('get_facts', {
    description: 'Bir entity için güncel fact kayıtlarını confidence ve temporal metadata ile getirir.',
    inputSchema: z.object({ id: z.string().min(1) })
  }, async ({ id }) => {
    const entity = await resolveEntity(id);
    if (!entity) return toolError('entity_not_found');
    return toolResult({ entityId: entity.id, facts: await getFactsDb(entity.id) });
  });

  server.registerTool('get_sources', {
    description: 'Bir entity için kaynak ve provenance kayıtlarını getirir.',
    inputSchema: z.object({ id: z.string().min(1) })
  }, async ({ id }) => {
    const entity = await resolveEntity(id);
    if (!entity) return toolError('entity_not_found');
    return toolResult({ entityId: entity.id, sources: await getSourcesDb(entity.id) });
  });

  server.registerTool('get_related', {
    description: 'Bir entity ile ilişkili diğer entity kayıtlarını getirir.',
    inputSchema: z.object({ id: z.string().min(1) })
  }, async ({ id }) => {
    const entity = await resolveEntity(id);
    if (!entity) return toolError('entity_not_found');
    return toolResult({ entityId: entity.id, relations: await getRelationsDb(entity.id) });
  });

  server.registerTool('submit_rating', {
    description: 'Dogrulanmis agent kimligiyle bir entity icin Agent Experience puanlari gonderir. Puanlar 1-5 arasindadir.',
    inputSchema: z.object({
      id: z.string().min(1),
      accuracy: z.number().min(1).max(5).optional(),
      freshness: z.number().min(1).max(5).optional(),
      completeness: z.number().min(1).max(5).optional(),
      machineReadability: z.number().min(1).max(5).optional(),
      comment: z.string().max(1000).optional()
    }).refine((value) => value.accuracy != null || value.freshness != null || value.completeness != null || value.machineReadability != null, {
      message: 'at_least_one_rating_required'
    })
  }, async ({ id, accuracy, freshness, completeness, machineReadability, comment }) => {
    if (!ctx.authInfo?.clientId) return toolError('authentication_required');
    if (!ctx.authInfo.scopes.includes('verified')) return toolError('verified_agent_required');
    const entity = await resolveEntity(id);
    if (!entity) return toolError('entity_not_found');
    const review = await createAgentReviewDb({
      agentId: ctx.authInfo.clientId,
      entityId: entity.id,
      accuracy,
      freshness,
      completeness,
      machineReadability,
      comment
    });
    if (!review) return toolError('database_required');
    await createAgentEventDb({
      agentId: ctx.authInfo.clientId,
      entityId: entity.id,
      eventType: 'entity_rated',
      payload: { message: 'Dogrulanmis bir agent entity verisini degerlendirdi', source: 'mcp' }
    });
    return toolResult({ accepted: true, review, agentScore: await getEntityAgentScoreDb(entity.id) });
  });

  server.registerTool('submit_contribution', {
    description: 'Kimligi dogrulanmis bir AgentBase agent tokeniyle yeni bilgi, duzeltme, kaynak veya iliski onerisi gonderir. Katki dogrudan canonical fact olmaz; inceleme kuyruguna girer.',
    inputSchema: z.object({
      id: z.string().min(1).optional(),
      contributionType: z.enum(['fact_add', 'fact_update', 'source_add', 'error_report', 'relation_add']),
      payload: z.record(z.string(), z.unknown()),
      evidence: z.array(z.unknown()).max(20).default([])
    })
  }, async ({ id, contributionType, payload, evidence }) => {
    if (!ctx.authInfo?.clientId) return toolError('authentication_required');
    let entityId: string | undefined;
    if (id) {
      const entity = await resolveEntity(id);
      if (!entity) return toolError('entity_not_found');
      entityId = entity.id;
    }
    const contribution = await createContributionDb({
      agentId: ctx.authInfo.clientId,
      entityId,
      contributionType,
      payload,
      evidence
    });
    if (!contribution) return toolError('database_required');
    await createAgentEventDb({
      agentId: ctx.authInfo.clientId,
      entityId,
      eventType: 'contribution_submitted',
      payload: { message: 'Bir agent bilgi katkisi gonderdi', contributionType, source: 'mcp' }
    });
    return toolResult({ accepted: true, reviewStatus: 'pending', contribution });
  });

  return server;
}

export const mcpHttpHandler = createMcpHandler(createAgentBaseMcpServer, {
  legacy: 'stateless'
});

export const mcpNodeHandler = toNodeHandler(mcpHttpHandler, {
  onerror: (error) => console.error('[mcp]', error)
});

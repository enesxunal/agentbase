import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
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

function createAgentBaseMcpServer() {
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

  return server;
}

export const mcpHttpHandler = createMcpHandler(createAgentBaseMcpServer, {
  legacy: 'stateless'
});

export const mcpNodeHandler = toNodeHandler(mcpHttpHandler, {
  onerror: (error) => console.error('[mcp]', error)
});

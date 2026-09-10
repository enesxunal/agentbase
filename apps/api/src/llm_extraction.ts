import { z } from 'zod';

export type LlmClaimCandidate = {
  subjectName: string | null;
  subjectType?: string | null;
  predicate: string;
  value: unknown;
  confidence: number;
  evidence?: string;
};

const ClaimSchema = z.object({
  subjectName: z.string().min(1).max(200).nullable().optional(),
  subjectType: z.string().min(1).max(120).nullable().optional(),
  predicate: z.string().min(2).max(120),
  value: z.unknown(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().min(1).max(500).optional()
});

const OutputSchema = z.object({ claims: z.array(ClaimSchema).max(50) });

const ALLOWED_PREDICATES = new Set([
  'schema:name','schema:description','schema:address','schema:telephone','schema:email','schema:url',
  'schema:openingHours','schema:servesCuisine','schema:priceRange','schema:foundingDate','schema:startDate',
  'schema:endDate','schema:eventStatus','schema:geo','ab:admission','ab:category','ab:familyFriendly',
  'ab:indoor','ab:outdoor','ab:wheelchairAccessible'
]);

function safeJsonFromText(raw: string) {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) { try { return JSON.parse(fenced); } catch {} }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {}
  }
  throw new Error('llm_invalid_json');
}

function normalizeCandidate(
  claim: z.infer<typeof ClaimSchema>,
  defaults: { subjectName: string | null; subjectType?: string | null },
  sourceText: string
): LlmClaimCandidate | null {
  if (!ALLOWED_PREDICATES.has(claim.predicate)) return null;
  const evidence = claim.evidence?.trim();
  if (!evidence || !sourceText.toLocaleLowerCase('tr-TR').includes(evidence.toLocaleLowerCase('tr-TR'))) return null;
  return {
    subjectName: claim.subjectName ?? defaults.subjectName,
    subjectType: claim.subjectType ?? defaults.subjectType ?? null,
    predicate: claim.predicate,
    value: claim.value,
    confidence: Math.min(0.79, Math.max(0.35, claim.confidence ?? 0.62)),
    evidence: `LLM candidate from visible text: ${evidence}`
  };
}

export function llmExtractionConfigured() {
  return Boolean(process.env.LLM_EXTRACTION_URL && process.env.LLM_EXTRACTION_MODEL);
}

export async function extractClaimsWithLlm(input: {
  rawText: string;
  subjectName: string | null;
  subjectType?: string | null;
}): Promise<LlmClaimCandidate[]> {
  if (!llmExtractionConfigured()) return [];

  const url = process.env.LLM_EXTRACTION_URL!;
  const model = process.env.LLM_EXTRACTION_MODEL!;
  const apiKey = process.env.LLM_EXTRACTION_API_KEY;
  const maxChars = Math.max(2000, Math.min(30000, Number(process.env.LLM_EXTRACTION_MAX_CHARS || 14000)));
  const sourceText = input.rawText.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  if (sourceText.length < 80) return [];

  const system = [
    'You extract factual claim candidates from Turkish web page text for a knowledge graph.',
    'Never infer a fact that is not explicitly stated in the supplied text.',
    'Return JSON only in the shape {"claims":[...]}.',
    `Allowed predicates: ${[...ALLOWED_PREDICATES].join(', ')}.`,
    'For every claim, evidence must be an exact short substring copied from the supplied text.',
    'Use conservative confidence between 0 and 1. If nothing reliable is present, return {"claims":[]}.'
  ].join(' ');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ subjectName: input.subjectName, subjectType: input.subjectType ?? null, text: sourceText }) }
      ]
    }),
    signal: AbortSignal.timeout(Math.max(3000, Math.min(45000, Number(process.env.LLM_EXTRACTION_TIMEOUT_MS || 15000))))
  });

  if (!response.ok) throw new Error(`llm_http_${response.status}`);
  const payload = await response.json() as any;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('llm_missing_content');

  const parsed = OutputSchema.safeParse(safeJsonFromText(content));
  if (!parsed.success) throw new Error('llm_invalid_schema');

  const out: LlmClaimCandidate[] = [];
  const seen = new Set<string>();
  for (const claim of parsed.data.claims) {
    const normalized = normalizeCandidate(claim, input, sourceText);
    if (!normalized) continue;
    const key = `${normalized.predicate}|${JSON.stringify(normalized.value)}|${normalized.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.slice(0, 30);
}

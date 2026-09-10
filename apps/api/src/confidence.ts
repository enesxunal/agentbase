export type ConfidenceSource = {
  authorityScore?: number | null;
  retrievedAt?: string | Date | null;
  type?: string | null;
};

export type ConfidenceInput = {
  claimConfidence: number;
  sources: ConfidenceSource[];
  supportingSourceCount: number;
  conflictingSourceCount: number;
  verifiedAgentReputation?: number | null;
  lastChecked?: string | Date | null;
};

export type ConfidenceBreakdown = {
  score: number;
  components: {
    extraction: number;
    sourceAuthority: number;
    freshness: number;
    agreement: number;
    agentTrust: number;
    conflictPenalty: number;
  };
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function daysSince(value?: string | Date | null) {
  if (!value) return 3650;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 3650;
  return Math.max(0, (Date.now() - date.getTime()) / 86400000);
}

function freshnessWeight(value?: string | Date | null) {
  const days = daysSince(value);
  if (days <= 7) return 1;
  if (days <= 30) return 0.92;
  if (days <= 90) return 0.78;
  if (days <= 180) return 0.62;
  if (days <= 365) return 0.45;
  return 0.25;
}

export function calculateConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  const extraction = clamp(input.claimConfidence);
  const sourceAuthority = input.sources.length
    ? input.sources.reduce((sum, source) => sum + clamp(Number(source.authorityScore ?? 0.5)), 0) / input.sources.length
    : 0.35;

  const freshestSource = input.sources
    .map((source) => source.retrievedAt)
    .filter(Boolean)
    .sort((a, b) => new Date(String(b)).getTime() - new Date(String(a)).getTime())[0];
  const freshness = freshnessWeight(freshestSource ?? input.lastChecked);

  const supporting = Math.max(0, input.supportingSourceCount);
  const conflicting = Math.max(0, input.conflictingSourceCount);
  const agreement = supporting + conflicting > 0
    ? clamp(supporting / (supporting + conflicting))
    : 0.5;

  const agentTrust = input.verifiedAgentReputation == null
    ? 0.5
    : clamp(Number(input.verifiedAgentReputation) / 100);

  const conflictPenalty = clamp(conflicting * 0.12, 0, 0.42);

  const raw =
    extraction * 0.24 +
    sourceAuthority * 0.31 +
    freshness * 0.16 +
    agreement * 0.19 +
    agentTrust * 0.10 -
    conflictPenalty;

  return {
    score: Number(clamp(raw, 0.05, 0.99).toFixed(3)),
    components: {
      extraction: Number(extraction.toFixed(3)),
      sourceAuthority: Number(sourceAuthority.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      agreement: Number(agreement.toFixed(3)),
      agentTrust: Number(agentTrust.toFixed(3)),
      conflictPenalty: Number(conflictPenalty.toFixed(3))
    }
  };
}

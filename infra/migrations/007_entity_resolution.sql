CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  source text NOT NULL DEFAULT 'system',
  confidence numeric(4,3) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entity_id, normalized_alias)
);

CREATE TABLE IF NOT EXISTS entity_resolution_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid REFERENCES extracted_claims(id) ON DELETE CASCADE,
  subject_name text NOT NULL,
  candidate_entity_id text REFERENCES entities(id) ON DELETE CASCADE,
  score numeric(5,4) NOT NULL,
  match_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(claim_id, candidate_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_trgm ON entity_aliases USING gin (normalized_alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON entities USING gin (lower(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_resolution_candidates_claim ON entity_resolution_candidates(claim_id, score DESC);

INSERT INTO entity_aliases (entity_id, alias, normalized_alias, source, confidence)
SELECT id, name, lower(regexp_replace(name, '[^[:alnum:]]+', '', 'g')), 'canonical', 1
FROM entities
ON CONFLICT (entity_id, normalized_alias) DO NOTHING;

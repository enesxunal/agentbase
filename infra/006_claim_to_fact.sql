ALTER TABLE extracted_claims ADD COLUMN IF NOT EXISTS promoted_fact_id text REFERENCES facts(id) ON DELETE SET NULL;
ALTER TABLE extracted_claims ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_extracted_claims_target_predicate
  ON extracted_claims(target_entity_id, predicate)
  WHERE target_entity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_sources_unique
  ON fact_sources(fact_id, source_id);

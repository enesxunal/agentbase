ALTER TABLE facts
  ADD COLUMN IF NOT EXISTS version_group_id uuid,
  ADD COLUMN IF NOT EXISTS version_no int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS superseded_by_fact_id text REFERENCES facts(id) ON DELETE SET NULL;

UPDATE facts SET version_group_id = gen_random_uuid() WHERE version_group_id IS NULL;
ALTER TABLE facts ALTER COLUMN version_group_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS fact_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id text NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  version_group_id uuid NOT NULL,
  version_no int NOT NULL,
  subject_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate text NOT NULL,
  value jsonb NOT NULL,
  confidence numeric(4,3) NOT NULL,
  status text NOT NULL,
  is_current boolean NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  superseded_by_fact_id text,
  change_type text NOT NULL,
  source_id text REFERENCES sources(id) ON DELETE SET NULL,
  claim_id uuid REFERENCES extracted_claims(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facts_current_subject_predicate ON facts(subject_entity_id, predicate, is_current);
CREATE INDEX IF NOT EXISTS idx_fact_versions_group_time ON fact_versions(version_group_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_versions_fact_time ON fact_versions(fact_id, recorded_at DESC);

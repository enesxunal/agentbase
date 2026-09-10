ALTER TABLE extracted_claims ADD COLUMN IF NOT EXISTS reviewed_by_agent_id text REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE extracted_claims ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE extracted_claims ADD COLUMN IF NOT EXISTS target_entity_id text REFERENCES entities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_extracted_claims_status ON extracted_claims(status, created_at);

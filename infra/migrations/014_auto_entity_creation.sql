ALTER TABLE extracted_claims
  ADD COLUMN IF NOT EXISTS subject_type text,
  ADD COLUMN IF NOT EXISTS auto_entity_created boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_entity_id text REFERENCES entities(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS entity_creation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid REFERENCES extracted_claims(id) ON DELETE SET NULL,
  entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_registry_id uuid REFERENCES source_registry(id) ON DELETE SET NULL,
  policy_version text NOT NULL,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claims_auto_entity ON extracted_claims(status, auto_entity_created, created_at);
CREATE INDEX IF NOT EXISTS idx_entity_creation_audit_entity ON entity_creation_audit(entity_id, created_at DESC);

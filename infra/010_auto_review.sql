ALTER TABLE extracted_claims
  ADD COLUMN IF NOT EXISTS auto_reviewed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_review_policy text,
  ADD COLUMN IF NOT EXISTS auto_review_reason jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS auto_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_registry_id uuid REFERENCES source_registry(id) ON DELETE SET NULL,
  examined int NOT NULL DEFAULT 0,
  accepted int NOT NULL DEFAULT 0,
  deferred int NOT NULL DEFAULT 0,
  conflicted int NOT NULL DEFAULT 0,
  policy_version text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claims_auto_review ON extracted_claims(status, auto_reviewed, created_at);
CREATE INDEX IF NOT EXISTS idx_auto_review_runs_source ON auto_review_runs(source_registry_id, created_at DESC);

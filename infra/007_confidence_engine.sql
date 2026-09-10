CREATE TABLE IF NOT EXISTS fact_confidence_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id text NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  score numeric(4,3) NOT NULL CHECK (score >= 0 AND score <= 1),
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fact_confidence_snapshots_fact_created
  ON fact_confidence_snapshots(fact_id, created_at DESC);

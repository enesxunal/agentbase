CREATE TABLE IF NOT EXISTS entity_embeddings (
  entity_id text PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  model text NOT NULL,
  dimensions int NOT NULL,
  vector real[] NOT NULL,
  content_hash text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entity_embeddings_model ON entity_embeddings(model);

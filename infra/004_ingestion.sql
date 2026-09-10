CREATE TABLE IF NOT EXISTS source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text UNIQUE NOT NULL,
  canonical_url text,
  title text,
  description text,
  content_type text,
  http_status int,
  etag text,
  last_modified text,
  body_hash text,
  raw_text text,
  jsonld jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  requested_by_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  error text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS extracted_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  subject_name text,
  predicate text NOT NULL,
  value jsonb NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','conflicting')),
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status_created ON ingestion_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_source_documents_fetched ON source_documents(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_extracted_claims_document ON extracted_claims(document_id);

CREATE TABLE IF NOT EXISTS source_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL UNIQUE,
  source_type text NOT NULL DEFAULT 'public' CHECK (source_type IN ('official','public','editorial','business')),
  authority_score numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (authority_score >= 0 AND authority_score <= 1),
  crawl_enabled boolean NOT NULL DEFAULT true,
  respect_robots boolean NOT NULL DEFAULT true,
  max_pages_per_run int NOT NULL DEFAULT 25 CHECK (max_pages_per_run > 0 AND max_pages_per_run <= 500),
  crawl_delay_ms int NOT NULL DEFAULT 1200 CHECK (crawl_delay_ms >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_crawled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_frontier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_registry_id uuid NOT NULL REFERENCES source_registry(id) ON DELETE CASCADE,
  url text NOT NULL,
  depth int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','blocked')),
  discovered_from text,
  last_error text,
  last_crawled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_registry_id, url)
);

CREATE INDEX IF NOT EXISTS idx_source_registry_enabled ON source_registry(crawl_enabled, last_crawled_at);
CREATE INDEX IF NOT EXISTS idx_source_frontier_queue ON source_frontier(source_registry_id, status, created_at);

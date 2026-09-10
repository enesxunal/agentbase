ALTER TABLE facts
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

UPDATE facts
SET last_verified_at = coalesce(last_checked, created_at)
WHERE status='verified' AND last_verified_at IS NULL;

ALTER TABLE source_registry
  ADD COLUMN IF NOT EXISTS refresh_interval_hours int,
  ADD COLUMN IF NOT EXISTS next_refresh_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_successful_crawl_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_failed_crawl_at timestamptz;

DO $$ BEGIN
  ALTER TABLE source_registry
    ADD CONSTRAINT source_registry_refresh_interval_hours_check
    CHECK (refresh_interval_hours IS NULL OR refresh_interval_hours BETWEEN 1 AND 8760);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_source_registry_due_refresh
  ON source_registry(next_refresh_at)
  WHERE crawl_enabled=true AND refresh_interval_hours IS NOT NULL;

CREATE TABLE IF NOT EXISTS business_discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('restaurant','cafe')),
  city text NOT NULL DEFAULT 'İstanbul',
  district text,
  website text,
  telephone text,
  address text,
  latitude double precision,
  longitude double precision,
  source_url text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','enrichment_queued','processed','rejected')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_processed_at timestamptz,
  UNIQUE(provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_business_discovery_city_status
  ON business_discovery_candidates(city, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_discovery_website
  ON business_discovery_candidates(website)
  WHERE website IS NOT NULL;

CREATE TABLE IF NOT EXISTS business_discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  city text NOT NULL,
  discovered int NOT NULL DEFAULT 0,
  with_website int NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

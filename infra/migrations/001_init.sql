CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS entities (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  location jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL,
  type text NOT NULL,
  authority_score numeric(4,3) NOT NULL DEFAULT 0.5,
  retrieved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facts (
  id text PRIMARY KEY,
  subject_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate text NOT NULL,
  value jsonb NOT NULL,
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL CHECK (status IN ('verified','observed','unknown','conflicting')),
  valid_from timestamptz,
  valid_to timestamptz,
  last_checked timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact_sources (
  fact_id text NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  evidence text,
  PRIMARY KEY (fact_id, source_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id text PRIMARY KEY,
  subject_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate text NOT NULL,
  object_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence numeric(4,3) NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  name text NOT NULL,
  developer text,
  website text,
  description text,
  verified boolean NOT NULL DEFAULT false,
  reputation numeric(5,2) NOT NULL DEFAULT 0,
  public_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_id text REFERENCES entities(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  accuracy numeric(4,3),
  freshness numeric(4,3),
  completeness numeric(4,3),
  machine_readability numeric(4,3),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm_fallback ON entities(lower(name));
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON agent_events(created_at DESC);

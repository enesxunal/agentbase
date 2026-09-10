CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  publisher TEXT,
  authority_score NUMERIC(4,3),
  retrieved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id TEXT UNIQUE NOT NULL,
  subject_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  value JSONB NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL CHECK (status IN ('verified','observed','unknown','conflicting')),
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  last_checked TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_sources (
  fact_id UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  evidence TEXT,
  PRIMARY KEY (fact_id, source_id)
);

CREATE TABLE relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX entities_type_idx ON entities(type);
CREATE INDEX facts_subject_idx ON facts(subject_entity_id);
CREATE INDEX relations_subject_idx ON relations(subject_entity_id);
CREATE INDEX relations_object_idx ON relations(object_entity_id);

CREATE INDEX IF NOT EXISTS idx_entities_search_simple
  ON entities USING gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(summary,'')));

CREATE INDEX IF NOT EXISTS idx_facts_value_search_simple
  ON facts USING gin (to_tsvector('simple', coalesce(value::text,'')));

CREATE INDEX IF NOT EXISTS idx_entities_name_trgm
  ON entities USING gin (lower(name) gin_trgm_ops);

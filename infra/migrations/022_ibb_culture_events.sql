INSERT INTO source_registry (name, base_url, source_type, authority_score, max_pages_per_run, crawl_delay_ms, respect_robots, metadata)
VALUES (
  'İBB Kültür Sanat',
  'https://kultursanat.istanbul/etkinliklerimiz/ara?page=1',
  'official',
  0.98,
  25,
  1200,
  true,
  '{"city":"İstanbul","scope":"events","bootstrap":"v1","crawlProfile":"ibb-culture-events-v1","allowedPathPrefixes":["/etkinliklerimiz"],"allowedQueryKeys":["page","category_id","tag_id"]}'::jsonb
)
ON CONFLICT (base_url) DO UPDATE SET
  name=excluded.name,
  source_type=excluded.source_type,
  authority_score=excluded.authority_score,
  max_pages_per_run=excluded.max_pages_per_run,
  crawl_delay_ms=excluded.crawl_delay_ms,
  respect_robots=excluded.respect_robots,
  metadata=source_registry.metadata || excluded.metadata,
  crawl_enabled=true,
  updated_at=now();

INSERT INTO source_frontier (source_registry_id,url,depth)
SELECT id,base_url,0 FROM source_registry
WHERE base_url='https://kultursanat.istanbul/etkinliklerimiz/ara?page=1'
ON CONFLICT (source_registry_id,url) DO NOTHING;

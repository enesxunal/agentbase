ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS source_registry_id uuid REFERENCES source_registry(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_source_documents_registry ON source_documents(source_registry_id, fetched_at DESC);

INSERT INTO source_registry (name, base_url, source_type, authority_score, max_pages_per_run, crawl_delay_ms, respect_robots)
VALUES
 ('Ankara Büyükşehir Belediyesi','https://www.ankara.bel.tr/','official',0.95,10,1500,true),
 ('Eskişehir Büyükşehir Belediyesi','https://www.eskisehir.bel.tr/','official',0.95,10,1500,true),
 ('Anıtkabir Resmi Sitesi','https://www.anitkabir.tsk.tr/','official',0.99,10,1500,true)
ON CONFLICT (base_url) DO UPDATE SET
 name=excluded.name, source_type=excluded.source_type, authority_score=excluded.authority_score,
 max_pages_per_run=excluded.max_pages_per_run, crawl_delay_ms=excluded.crawl_delay_ms, respect_robots=excluded.respect_robots;

INSERT INTO source_frontier (source_registry_id,url,depth)
SELECT id,base_url,0 FROM source_registry
WHERE base_url IN ('https://www.ankara.bel.tr/','https://www.eskisehir.bel.tr/','https://www.anitkabir.tsk.tr/')
ON CONFLICT (source_registry_id,url) DO NOTHING;

INSERT INTO source_registry (name, base_url, source_type, authority_score, max_pages_per_run, crawl_delay_ms, respect_robots, metadata)
VALUES
 ('T.C. Kültür ve Turizm Bakanlığı','https://www.ktb.gov.tr/','official',0.99,20,1500,true,'{"scope":"culture-tourism","bootstrap":"v1"}'::jsonb),
 ('MüzeKart / T.C. Kültür ve Turizm Bakanlığı','https://www.muze.gov.tr/','official',0.99,30,1500,true,'{"scope":"museums-archaeological-sites","bootstrap":"v1"}'::jsonb),
 ('İstanbul Büyükşehir Belediyesi','https://www.ibb.istanbul/','official',0.97,20,1500,true,'{"city":"İstanbul","scope":"municipality","bootstrap":"v1"}'::jsonb),
 ('İzmir Büyükşehir Belediyesi','https://www.izmir.bel.tr/','official',0.97,20,1500,true,'{"city":"İzmir","scope":"municipality","bootstrap":"v1"}'::jsonb),
 ('Antalya Büyükşehir Belediyesi','https://www.antalya.bel.tr/','official',0.97,20,1500,true,'{"city":"Antalya","scope":"municipality","bootstrap":"v1"}'::jsonb),
 ('Bursa Büyükşehir Belediyesi','https://www.bursa.bel.tr/','official',0.97,20,1500,true,'{"city":"Bursa","scope":"municipality","bootstrap":"v1"}'::jsonb),
 ('Konya Büyükşehir Belediyesi','https://www.konya.bel.tr/','official',0.97,20,1500,true,'{"city":"Konya","scope":"municipality","bootstrap":"v1"}'::jsonb),
 ('Gaziantep Büyükşehir Belediyesi','https://www.gaziantep.bel.tr/','official',0.97,20,1500,true,'{"city":"Gaziantep","scope":"municipality","bootstrap":"v1"}'::jsonb),
 ('Mersin Büyükşehir Belediyesi','https://www.mersin.bel.tr/','official',0.97,20,1500,true,'{"city":"Mersin","scope":"municipality","bootstrap":"v1"}'::jsonb),
 ('Muğla Büyükşehir Belediyesi','https://www.mugla.bel.tr/','official',0.97,20,1500,true,'{"city":"Muğla","scope":"municipality","bootstrap":"v1"}'::jsonb)
ON CONFLICT (base_url) DO UPDATE SET
 name=excluded.name,
 source_type=excluded.source_type,
 authority_score=excluded.authority_score,
 max_pages_per_run=excluded.max_pages_per_run,
 crawl_delay_ms=excluded.crawl_delay_ms,
 respect_robots=excluded.respect_robots,
 metadata=source_registry.metadata || excluded.metadata,
 updated_at=now();

INSERT INTO source_frontier (source_registry_id,url,depth)
SELECT id,base_url,0 FROM source_registry
WHERE metadata->>'bootstrap'='v1'
ON CONFLICT (source_registry_id,url) DO NOTHING;

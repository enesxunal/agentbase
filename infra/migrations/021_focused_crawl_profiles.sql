-- Keep broad official sites in the registry, but constrain unattended crawling
-- to high-signal content sections. This prevents navigation/search/account pages
-- from becoming low-quality knowledge candidates.
UPDATE source_registry
SET metadata = metadata || '{"allowedPathPrefixes":["/muzeler","/muze-detay"],"allowedQueryKeys":["SectionId","DistId"],"crawlProfile":"museum-directory-v2"}'::jsonb,
    updated_at = now()
WHERE base_url='https://www.muze.gov.tr/muzeler';

-- IBB root contains many unrelated municipal/service links. Start with its
-- official event agenda and only follow the event section on the same origin.
WITH target AS (
  UPDATE source_registry
  SET base_url='https://www.ibb.istanbul/gundem/etkinlikler',
      max_pages_per_run=20,
      metadata=metadata || '{"scope":"events","allowedPathPrefixes":["/gundem/etkinlikler"],"crawlProfile":"municipal-events-v1"}'::jsonb,
      updated_at=now()
  WHERE base_url='https://www.ibb.istanbul/'
  RETURNING id
)
DELETE FROM source_frontier f USING target t WHERE f.source_registry_id=t.id;

INSERT INTO source_frontier (source_registry_id,url,depth)
SELECT id,base_url,0 FROM source_registry WHERE base_url='https://www.ibb.istanbul/gundem/etkinlikler'
ON CONFLICT (source_registry_id,url) DO NOTHING;

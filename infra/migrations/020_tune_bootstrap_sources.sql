-- The ministry root is authoritative but too broad for unattended crawling.
-- Keep it in the registry for provenance/manual targeting, disable recursive crawl for now.
UPDATE source_registry
SET crawl_enabled=false,
    metadata=metadata || '{"crawlProfile":"manual-targets","bootstrapNote":"Broad ministry navigation is low-signal; use targeted cultural pages."}'::jsonb,
    updated_at=now()
WHERE base_url='https://www.ktb.gov.tr/';

-- Start the museum source from the official museum directory so same-origin discovery
-- prioritizes museum and archaeological-site detail pages instead of generic navigation.
WITH target AS (
  UPDATE source_registry
  SET base_url='https://www.muze.gov.tr/muzeler',
      max_pages_per_run=30,
      metadata=metadata || '{"crawlProfile":"museum-directory","allowedPathHint":"/muze-detay"}'::jsonb,
      updated_at=now()
  WHERE base_url='https://www.muze.gov.tr/'
  RETURNING id
)
DELETE FROM source_frontier f USING target t WHERE f.source_registry_id=t.id;

INSERT INTO source_frontier (source_registry_id,url,depth)
SELECT id,base_url,0 FROM source_registry WHERE base_url='https://www.muze.gov.tr/muzeler'
ON CONFLICT (source_registry_id,url) DO NOTHING;

-- Backfill city metadata for event entities created from city-scoped official sources.
UPDATE entities e
SET location = jsonb_build_object('city', src.city, 'country', 'Türkiye'),
    updated_at = now()
FROM (
  SELECT DISTINCT c.target_entity_id AS entity_id, sr.metadata->>'city' AS city
  FROM extracted_claims c
  JOIN source_documents d ON d.id = c.document_id
  JOIN source_registry sr ON sr.id = d.source_registry_id
  WHERE c.target_entity_id IS NOT NULL
    AND sr.metadata ? 'city'
    AND sr.metadata->>'city' <> ''
) src
WHERE e.id = src.entity_id
  AND e.type = 'event'
  AND (e.location IS NULL OR COALESCE(e.location->>'city','') = '');
